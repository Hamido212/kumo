// Neon Horizon: a striped sun sinks between low-poly mountains, and a glowing grid rolls slowly
// towards the viewer. Lines are measured in pixels with screen-space derivatives, so they stay
// one or two pixels wide at any size and fade before they get dense enough to shimmer.

#define HORIZON -0.08
#define SUN_Y (HORIZON + 0.12)
#define SUN_R 0.19

float3 gridColor() { return pick(float3(1.00, 0.10, 0.62), float3(1.00, 0.30, 0.04), float3(0.05, 0.65, 1.00)); }
float3 sunTop() { return pick(float3(1.00, 0.80, 0.22), float3(1.00, 0.82, 0.30), float3(0.70, 0.95, 1.00)); }
float3 sunBottom() { return pick(float3(1.00, 0.08, 0.42), float3(0.95, 0.07, 0.03), float3(0.30, 0.18, 1.00)); }
float3 hazeColor() { return pick(float3(0.42, 0.04, 0.36), float3(0.42, 0.07, 0.03), float3(0.04, 0.12, 0.42)); }
float3 skyTop() { return pick(float3(0.004, 0.002, 0.020), float3(0.008, 0.002, 0.006), float3(0.001, 0.004, 0.016)); }

// piecewise linear noise: the sharp peaks of low-poly mountains
float lin(float x, float row) {
  float i = floor(x), f = x - i;
  return lerp(u01(hashu(int2(int(i), int(row)))), u01(hashu(int2(int(i) + 1, int(row)))), f);
}

float mountains(float x) {
  float side = ss(0.12, 0.85, abs(x));
  float n = 0.6 * lin(x * 3.6 + 0.5, 1.0) + 0.3 * lin(x * 8.3, 2.0) + 0.1 * lin(x * 19.0, 3.0);
  return (0.01 + 0.2 * side) * (0.3 + 0.7 * n);
}

float3 stars(float2 p, float t) {
  float2 g = p * 40.0;
  float2 c = floor(g);
  float3 r = hash3(c);
  if (r.z > 0.32) return 0.0;
  float d = length(g - (c + 0.15 + 0.7 * r.xy)) / (40.0 * PX);
  float b = 0.05 + 0.9 * pow(r.z / 0.32, 8.0);
  return lerp(float3(0.8, 0.85, 1.0), float3(1.0, 0.8, 0.95), r.x) * b * (0.8 + 0.2 * sin(t * (0.4 + r.y) + r.x * TAU)) * exp(-d * d * 0.8);
}

float3 effect(float2 p, float t) {
  float up = p.y - HORIZON;
  float glowSun = lerp(1.0, 0.6, NIGHT) * (1.0 + 0.2 * WARM);
  float3 haze = hazeColor() * lerp(1.0, 0.75, NIGHT) * lerp(1.0.xxx, float3(1.3, 0.9, 0.6), WARM * 0.5);
  float3 c;

  if (up >= 0.0) {
    c = lerp(haze * 0.22, skyTop(), ss(0.0, 0.5, up));
    c += haze * 0.35 * exp(-up * 14.0);
    c += stars(p, t) * ss(0.15, 0.45, up);

    float2 s = p - float2(0.0, SUN_Y);
    float r = length(s);
    float yy = s.y / SUN_R;
    float3 sun = lerp(sunBottom(), sunTop(), ss(-0.9, 0.8, yy)) * 2.2;
    // gaps that widen towards the bottom and drift down slowly
    float band = frac(yy * 5.0 + t * 0.07);
    float w = max(fwidth(yy * 5.0), 1e-4) * 1.2;
    float gap = 0.12 + 0.5 * ss(-0.05, -1.0, yy);
    float open = ss(gap - w, gap + w, band) * ss(1.0, 1.0 - w, band);
    open = lerp(open, 1.0, ss(-0.02, 0.06, yy));
    float disc = ss(SUN_R + PX, SUN_R - PX, r) * open;
    c += sun * disc * glowSun;
    c += sunBottom() * exp(-max(r - SUN_R, 0.0) * 10.0) * 0.18 * glowSun * (1.0 - disc);

    float m = mountains(p.x);
    if (up < m) {
      float3 rock = lerp(haze * 0.10, float3(0.004, 0.001, 0.010), ss(0.0, m * 0.7, up));
      c = rock + gridColor() * exp(-(m - up) / (1.3 * PX)) * 0.6;
      // faint contour lines on the slopes, like a wireframe seen at dusk
      float lines = abs(frac((m - up) * 60.0) - 0.5) / max(fwidth((m - up) * 60.0), 1e-4);
      c += gridColor() * (1.0 - ss(0.5, 1.5, lines)) * 0.05 * ss(0.0, 0.03, m - up);
    }
  } else {
    float below = -up;
    float z = 0.32 / below;
    float2 g = float2(p.x * z, z + t * 0.45);
    float2 fw = max(fwidth(g), 1e-5);
    float2 d = abs(frac(g + 0.5) - 0.5) / fw;
    float fx = ss(0.40, 0.16, fw.x), fy = ss(0.30, 0.10, fw.y);
    float lit = max((1.0 - ss(0.4, 1.4, d.x)) * fx, (1.0 - ss(0.4, 1.4, d.y)) * fy);
    float halo = (exp(-d.x * 0.4) * fx + exp(-d.y * 0.4) * fy) * 0.22;
    float near = exp(-z * 0.06);
    c = float3(0.003, 0.001, 0.008) + haze * 0.28 * exp(-below * 14.0);
    c += gridColor() * (lit * lerp(0.4, 1.5, near) + halo * near);
    // the sun's path on the floor
    c += sunBottom() * exp(-abs(p.x) * 7.0) * exp(-below * 9.0) * 0.15 * glowSun;
  }
  c += haze * exp(-abs(up) / (2.0 * PX)) * 0.35;

  c = daytint(c, 0.3, 0.12);
  float2 v = p / float2(max(ASPECT, 1.0), 1.0);
  c *= 1.0 - 0.4 * ss(0.3, 1.0, length(v * float2(1.0, 1.1)));
  return encode(tonemapHue(c * 1.1));
}
