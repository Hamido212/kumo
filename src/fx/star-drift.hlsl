// Star Drift: stars stream slowly out of a point right of centre, as if the view drifted through
// space. Ten layers of stars sit at depths that cycle from far to near; a star fades in far away
// and out again before it would move fast, so nothing ever rushes past, and each pass of a layer
// brings new stars. Behind them lie a haze of gas and a fine dust of distant stars.

#define LAYERS 10
#define VANISH float2(0.2, 0.05)
#define CELL 0.6

float3 starTint(float r) { return pick(lerp(float3(0.70, 0.80, 1.00), float3(1.00, 0.92, 0.80), r), lerp(float3(1.00, 0.78, 0.52), float3(1.00, 0.95, 0.85), r), lerp(float3(0.55, 0.88, 1.00), float3(0.85, 0.95, 1.00), r)); }
float3 hazeA() { return pick(float3(0.10, 0.14, 0.45), float3(0.45, 0.16, 0.05), float3(0.04, 0.28, 0.34)); }
float3 hazeB() { return pick(float3(0.34, 0.08, 0.36), float3(0.40, 0.06, 0.14), float3(0.10, 0.12, 0.42)); }

float3 effect(float2 p, float t) {
  float2 rel = p - VANISH;
  float3 c = float3(0.0010, 0.0013, 0.0035);
  // the haze turns very slowly around the vanishing point
  float a = t * 0.004;
  float2 hq = mul(float2x2(cos(a), -sin(a), sin(a), cos(a)), rel) * 1.3;
  float haze = max(exp(2.4 * fbm3(hq + 2.3)) - 0.6, 0.0);
  c += lerp(hazeA(), hazeB(), ss(-0.5, 0.5, gnoise(hq * 0.7 + 9.0))) * haze * 0.02;
  // a far galaxy's band across the sky, with dark lanes of dust in it
  float across = dot(hq, float2(0.5, 0.866)) + 0.12 * gnoise(hq * 1.1 + 4.0);
  float lane = ss(0.0, 0.45, fbm3(mul(float2x2(0.5, 0.866, -0.866, 0.5), hq) * float2(1.2, 3.5) + 6.0));
  float glow = exp(-across * across * 7.0) * max(0.5 + 0.5 * fbm3(hq * 2.4 + 1.0), 0.0) * (1.0 - 0.8 * lane);
  c += lerp(hazeB(), float3(0.60, 0.55, 0.50), 0.45) * glow * 0.11;

  // fine dust of distant stars, turning with the haze
  float2 g = hq * 55.0;
  float3 dr = hash3(floor(g) + 7.0);
  if (dr.z < 0.35) {
    float l = length(g - (floor(g) + 0.2 + 0.6 * dr.xy)) / (55.0 * 1.3 * PX);
    c += starTint(dr.x) * (0.05 + 0.25 * pow(dr.z / 0.35, 4.0)) * exp(-l * l * 0.9);
  }

  [loop] for (int i = 0; i < LAYERS; i++) {
    // each pass of a layer brings new stars: the cycle number is part of the seed
    float phase = t * 0.02 + i / (float)LAYERS;
    float z = frac(phase);
    float seed = i * 101.0 + floor(phase) * 37.0;
    float2 shift = float2(seed * 0.173, seed * 0.071);
    float depth = lerp(9.0, 0.8, z);
    float2 w = rel * depth / CELL + shift;
    float2 cell = floor(w);
    float3 r = hash3(cell + seed);
    if (r.z > 0.5) continue;
    float2 star = cell + 0.25 + 0.5 * r.xy;
    float2 d = (w - star) * CELL / depth / PX;
    // a little longer along the way it moves, the faster the longer
    float2 away = normalize(star - shift + 1e-4);
    float speed = length(star - shift) * CELL / (depth * depth);
    float along = dot(d, away) / (1.0 + max(speed - 0.15, 0.0) * 2.0);
    float across = dot(d, float2(-away.y, away.x));
    float size = 0.8 + 1.2 * z;
    float k = pow(r.z / 0.5, 3.0);
    float b = (0.2 + 1.6 * k) * (0.3 + 0.9 * z) * ss(0.0, 0.3, z) * ss(1.0, 0.72, z);
    c += starTint(r.x) * b * exp(-(along * along + across * across) / (size * size));
  }

  c = daytint(c, 0.45, 0.15);
  float2 v = p / float2(max(ASPECT, 1.0), 1.0);
  c *= 1.0 - 0.3 * ss(0.4, 1.0, length(v));
  return encode(tonemapHue(c * 1.2));
}
