// Shared part of every shader wallpaper (src/fx/*.hlsl). build.rs puts this file in front of each
// effect and compiles the pair to fx-<name>.cso; nothing is compiled when Kumo starts.
//
// An effect defines `float3 effect(float2 p, float t)`: the colour (sRGB-encoded, 0..1) at point
// p, where p is the pixel centre in a frame that is 1 unit high, centred, y up. It is drawn into
// a 10-bit target below screen size; the post pass scales it up and dithers it, so effects only
// have to stay smooth. All motion comes from t (seconds, may be negative), never from frames.
//
// Everything here is Kumo's own code. The techniques are textbook: value and gradient noise,
// fractal sums, domain warping, an integer hash (PCG, after Jarzynski and Olano, "Hash Functions
// for GPU Rendering", 2020).

cbuffer Fx : register(b0) {
  float4 fxTime;   // x: seconds, wrapped; y: hour of day 0..24; z: cross-fade weight; w: wrap length
  float4 fxRes;    // xy: target size in pixels, zw: 1 / size
  float4 fxSky;    // x: night 0..1, y: warm light of dawn and dusk 0..1, z: sun height -1..1, w: style 0, 1, 2
};

struct FsOut { float4 pos : SV_Position; float2 ndc : TEXCOORD0; };

#define PI 3.14159265
#define TAU 6.28318531

#define NIGHT fxSky.x
#define WARM fxSky.y
#define SUN fxSky.z
#define STYLE ((int)(fxSky.w + 0.5))
// one pixel of the target in frame units, and the frame's width
#define PX fxRes.w
#define ASPECT (fxRes.x * fxRes.w)

float ss(float a, float b, float x) { float t = saturate((x - a) / (b - a)); return t * t * (3.0 - 2.0 * t); }

// ---------------------------------------------------------------- hashes

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

uint hashu(int2 c) { return pcg(asuint(c.x) + pcg(asuint(c.y))); }

float u01(uint h) { return float(h >> 8) * (1.0 / 16777216.0); }

Texture2D noiseTex : register(t0);
SamplerState noiseSmp : register(s0); // point, wrap

// random numbers 0..1 per integer cell, read from the noise texture (repeats every 256 cells,
// which no star field or row of trees here ever shows)
float4 cellRandom(float2 cell) { return noiseTex.Load(int3(int2(floor(cell)) & 255, 0)); }
float2 hash2(float2 cell) { return cellRandom(cell).xy; }
float3 hash3(float2 cell) { return cellRandom(cell).xyz; }

// ---------------------------------------------------------------- noise
//
// The random numbers behind the noise come from a 256x256 texture of random bytes that
// shader.rs makes once. One Gather fetches the four corners of a cell, which is much cheaper
// than hashing them (integer multiplies are slow on many integrated GPUs); the interpolation
// stays in full float precision, so even very soft noise shows no steps. Channels: r and g
// gradient x and y, b values, a 1D gradients.

// the four corners of cell i in Gather order: x (0,1), y (1,1), z (1,0), w (0,0)
float2 cellUv(float2 i) { return (i + 1.0) * (1.0 / 256.0); }

// value noise, 0..1
float vnoise(float2 p) {
  float2 i = floor(p), f = p - i;
  float2 u = f * f * (3.0 - 2.0 * f);
  float4 v = noiseTex.GatherBlue(noiseSmp, cellUv(i));
  return lerp(lerp(v.w, v.z, u.x), lerp(v.x, v.y, u.x), u.y);
}

// 1D value noise along x of row `row`, 0..1
float vnoise1(float x, float row) {
  float i = floor(x), f = x - i;
  float4 v = noiseTex.GatherBlue(noiseSmp, cellUv(float2(i, row)));
  return lerp(v.w, v.z, f * f * (3.0 - 2.0 * f));
}

// gradient noise, about -0.7..0.7, smoother than value noise
float gnoise(float2 p) {
  float2 i = floor(p), f = p - i;
  float2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float2 uv = cellUv(i);
  float4 gx = noiseTex.GatherRed(noiseSmp, uv) * 2.0 - 1.0;
  float4 gy = noiseTex.GatherGreen(noiseSmp, uv) * 2.0 - 1.0;
  float a = gx.w * f.x + gy.w * f.y;
  float b = gx.z * (f.x - 1.0) + gy.z * f.y;
  float d = gx.x * f.x + gy.x * (f.y - 1.0);
  float e = gx.y * (f.x - 1.0) + gy.y * (f.y - 1.0);
  return lerp(lerp(a, b, u.x), lerp(d, e, u.x), u.y);
}

// 1D gradient noise along x of row `row`, about -0.5..0.5
float gnoise1(float x, float row) {
  float i = floor(x), f = x - i;
  float u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float4 g = noiseTex.GatherAlpha(noiseSmp, cellUv(float2(i, row))) * 2.0 - 1.0;
  return lerp(g.w * f, g.z * (f - 1.0), u);
}

static const float2x2 OCTAVE = float2x2(1.6, 1.2, -1.2, 1.6); // rotate by 37 degrees, scale by 2

// fractal sums of gradient noise, about -1..1
float fbm3(float2 p) {
  float s = gnoise(p) * 0.57;
  p = mul(OCTAVE, p) + 17.3;
  s += gnoise(p) * 0.29;
  p = mul(OCTAVE, p) + 31.7;
  s += gnoise(p) * 0.14;
  return s * 1.45;
}

float fbm5(float2 p) {
  float s = 0.0, a = 0.52;
  [unroll] for (int k = 0; k < 5; k++) {
    s += gnoise(p) * a;
    p = mul(OCTAVE, p) + float2(13.1, 7.7) * (k + 1);
    a *= 0.5;
  }
  return s * 1.45;
}

// ---------------------------------------------------------------- colour

float3 tonemap(float3 c) { return 1.0 - exp(-max(c, 0.0)); }
// the same curve on the brightest channel only: bright colours keep their hue instead of
// washing out to white (neon, auroras)
float3 tonemapHue(float3 c) {
  c = max(c, 0.0);
  float m = max(c.r, max(c.g, c.b));
  return c * ((1.0 - exp(-m)) / max(m, 1e-5));
}
float3 encode(float3 c) { return pow(saturate(c), 1.0 / 2.2); }
float luma(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }

// the evening makes everything a little warmer, the night a little darker (linear colour)
float3 daytint(float3 c, float warmth, float dark) {
  c *= lerp(1.0.xxx, float3(1.12, 0.98, 0.84), WARM * warmth);
  return c * (1.0 - NIGHT * dark);
}

// three colours per style
float3 pick(float3 a, float3 b, float3 c) { return STYLE == 1 ? b : STYLE == 2 ? c : a; }

// ---------------------------------------------------------------- entry

float3 effect(float2 p, float t);

float4 main(FsOut i) : SV_Target {
  float2 p = (i.pos.xy - 0.5 * fxRes.xy) * fxRes.w * float2(1.0, -1.0);
  float3 c = effect(p, fxTime.x);
  // the clock wraps every fxTime.w seconds; just before that the picture fades into its own
  // continuation, so the wrap never shows
  [branch] if (fxTime.z > 0.0) c = lerp(c, effect(p, fxTime.x - fxTime.w), fxTime.z);
  return float4(c, 1.0);
}
