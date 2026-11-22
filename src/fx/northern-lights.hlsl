// Northern Lights: curtains of light over mountains and a still lake.
//
// Each curtain is a vertical sheet standing on a slowly folding line in the ground plan that runs
// from far away on the left to nearer on the right. Along each view ray the shader looks for the
// places where the ray passes over that line (twelve samples in the plan, no 3D ray marching) and
// adds the light of the sheet there: that gives real perspective, folds that glow where the sheet
// is seen edge-on, and rays that run up the sheet. The lake shows the same sky, mirrored.

#define HORIZON -0.2
#define BASE 0.55  // height of the curtains' lower edge above the eye
#define TOP 3.0
#define SAMPLES 12

float3 lowColor() { return pick(float3(0.06, 0.95, 0.38), float3(0.95, 0.16, 0.42), float3(0.06, 0.72, 1.00)); }
float3 highColor() { return pick(float3(0.20, 0.05, 0.42), float3(0.38, 0.03, 0.12), float3(0.12, 0.08, 0.60)); }

// depth of a curtain's foot at sideways position x: from far on the left to near on the right,
// with folds that drift and change shape over minutes
float foot(float x, float z0, float tilt, float seed, float t) {
  // the straight line, bent smoothly so it never comes nearer than 1.3
  float base = z0 - tilt * x;
  base = 1.3 + 0.5 * log(1.0 + exp(2.0 * (base - 1.3)));
  float fold = 3.2 * gnoise1(x * 0.55 + t * 0.012, seed) + 1.1 * gnoise1(x * 1.5 - t * 0.02, seed + 5.0);
  return base + fold * ss(1.3, 3.0, base);
}

// the sheet's light where the ray crosses its foot at depth z; dgdz: how steeply the ray crosses
float3 sheet(float2 dir, float z, float dgdz, float seed, float strength, float t) {
  float x = z * dir.x;
  float above = z * dir.y - BASE;
  // brighter where the sheet is seen edge-on, but fading where a fold turns away, so the two
  // crossings of a fold vanish together instead of ending in a hard line
  float fold = min(0.45 / max(abs(dgdz), 0.12), 3.0) * ss(0.0, 0.3, abs(dgdz));
  float edge = z * 2.5 * PX + 0.01;
  float body = ss(-edge, edge, above) * exp(-max(above, 0.0) * 1.8) * ss(TOP - BASE, TOP - BASE - 1.4, above);
  float haze = exp(-max(-above, 0.0) * 10.0) * 0.04;
  // rays run up the sheet and drift along it; brightness wanders along the arc over minutes
  float rays = 0.2 + 0.8 * pow(vnoise(float2(x * 5.0 + t * 0.17, above * 0.45 - t * 0.035 + seed)), 2.0);
  rays *= 0.65 + 0.7 * vnoise1(x * 17.0 - t * 0.28, seed + 3.0);
  float active = ss(0.05, 0.6, vnoise1(x * 0.3 + t * 0.013 + seed * 3.0, seed)) * ss(-12.0, -6.0, x) * ss(10.0, 5.0, x);
  // fade out at both ends of the searched depths, so nothing ends in a hard line
  float range = ss(0.7, 1.2, z) * ss(26.0, 16.0, z);
  float3 col = lerp(lowColor(), highColor(), ss(0.05, 1.5, above));
  // a thin rose fringe under the green edge, as in strong displays
  col += float3(0.8, 0.10, 0.30) * ss(edge, -edge, above) * ss(-0.08, 0.0, above) * (STYLE == 0 ? 0.6 : 0.0);
  return col * (body * rays * fold + haze) * active * range * exp(-z * 0.045) * strength;
}

// light of one curtain along the view ray; dir: sideways and upwards per unit of depth. The ray
// may pass over a folded foot more than once: up to three crossings count.
float3 curtain(float2 dir, float z0, float tilt, float seed, float strength, float t) {
  float3 light = 0.0;
  float zPrev = 0.7;
  float gPrev = foot(zPrev * dir.x, z0, tilt, seed, t) - zPrev;
  // a real loop (not unrolled): the sheet's code exists once
  [loop] for (int k = 1; k < SAMPLES; k++) {
    float z = 0.7 * pow(40.0, k / (SAMPLES - 1.0));
    float g = foot(z * dir.x, z0, tilt, seed, t) - z;
    [branch] if (g * gPrev <= 0.0 && gPrev != g) {
      light += sheet(dir, lerp(zPrev, z, gPrev / (gPrev - g)), (g - gPrev) / (z - zPrev), seed, strength, t);
    }
    zPrev = z;
    gPrev = g;
  }
  return light;
}

// the far range: higher to the right
float ridge(float x) {
  float peaks = 1.0 - abs(gnoise(float2(x * 2.1, 3.3))) * 1.7;
  float r = 0.018 + 0.07 * ss(-1.2, 1.0, x) * max(peaks, 0.0) + 0.03 * ss(0.2, -1.4, x) * max(peaks, 0.2);
  return r + 0.008 * gnoise(float2(x * 7.0, 9.1)) + 0.003 * gnoise(float2(x * 23.0, 1.7));
}

// the near shore: spruce tops, a row of narrow spikes, low in the middle
float trees(float x) {
  float side = ss(0.05, 1.0, abs(x - 0.15) / max(ASPECT * 0.5, 0.6));
  float hill = 0.006 + 0.035 * side * (0.5 + 0.5 * vnoise1(x * 4.0, 11.0));
  float cell = x / 0.011;
  float best = 0.0;
  [unroll] for (int k = -1; k <= 1; k++) {
    float c = floor(cell) + k;
    float2 r = hash2(float2(c, 13.0));
    float d = abs(cell - (c + 0.5 + (r.x - 0.5) * 0.6));
    float tall = (0.006 + 0.03 * r.y * r.y) * (0.3 + side);
    best = max(best, tall * saturate(1.0 - d / (0.55 + r.y * 0.6)));
  }
  return hill + best;
}

float3 stars(float2 q, float t) {
  float2 g = q * 42.0;
  float2 c = floor(g);
  float3 r = hash3(c);
  if (r.z > 0.5) return 0.0;
  float2 at = c + 0.15 + 0.7 * r.xy;
  float d = length(g - at) / (42.0 * PX);
  float b = 0.04 + 1.4 * pow(r.z / 0.5, 10.0);
  float tw = 0.8 + 0.2 * sin(t * (0.5 + r.x * 1.3) + r.y * TAU);
  float3 tint = lerp(float3(0.75, 0.85, 1.0), float3(1.0, 0.88, 0.72), r.x);
  return tint * b * tw * exp(-d * d * 0.9);
}

// everything above the waterline as seen along screen point p
float3 sky(float2 p, float t, bool mirrored) {
  float up = p.y - HORIZON;
  float3 c = lerp(float3(0.004, 0.011, 0.022), float3(0.0008, 0.0016, 0.0055), ss(0.0, 0.55, up));
  float day = (1.0 - NIGHT) * (1.0 - WARM);
  c += day * float3(0.005, 0.013, 0.03) * saturate(1.1 - up * 1.2);
  c += WARM * float3(0.055, 0.020, 0.013) * exp(-up * 9.0);
  float lights = lerp(0.55, 1.0, NIGHT);

  float2 dir = float2(p.x, up);
  float3 a = curtain(dir, 3.4, 0.95, 1.0, 1.0, t);
  a += curtain(dir, 10.0, 0.35, 2.0, 0.5, t);
  c += a * lights;
  if (!mirrored) c += stars(p, t) * ss(0.02, 0.3, up) * lerp(0.35, 1.0, NIGHT) * (1.0 - saturate(luma(a) * 3.0));

  float glow = luma(a) * 0.3 + 0.002;
  float r = ridge(p.x);
  if (up < r) {
    // the far range, lit faintly by the curtains, a little lighter at its foot
    float3 rock = float3(0.003, 0.005, 0.010) + lowColor() * glow * 0.06;
    c = lerp(rock * 1.5, rock, ss(0.0, r, up)) + WARM * float3(0.008, 0.003, 0.002);
  }
  if (up < trees(p.x)) c = float3(0.0008, 0.0012, 0.0022);
  return c;
}

float3 effect(float2 p, float t) {
  float3 c;
  if (p.y >= HORIZON) {
    c = sky(p, t, false);
  } else {
    // the lake: ripples recede towards the shore
    float below = HORIZON - p.y;
    float depth = 0.25 / below;
    float2 w = float2(p.x * depth, depth);
    float ripple = gnoise(w * float2(1.0, 4.0) + float2(0.0, t * 0.16)) + 0.5 * gnoise(w * float2(2.6, 9.0) - float2(t * 0.09, 0.0));
    float2 m = float2(p.x + ripple * 0.003 * below, HORIZON + below + ripple * 0.004 * below);
    c = sky(m, t, true) * lerp(0.42, 0.18, ss(0.0, 0.3, below)) + float3(0.0006, 0.001, 0.002);
  }
  c = daytint(c, 0.6, 0.15);
  float2 v = p / float2(max(ASPECT, 1.0), 1.0);
  c *= 1.0 - 0.3 * ss(0.3, 1.0, length(v * float2(1.0, 1.2)));
  return encode(tonemapHue(c * 1.25));
}
