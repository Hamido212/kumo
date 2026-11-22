// Ocean Swell: a calm sea under the sky of the hour. The sun rises, stands and sets with your
// clock (the moon takes over at night) and lays its path of light across the water.
//
// The sea is a plane with a sum of six swells on it (each moves at the speed of real water waves
// of its length, slowed down); their slopes give the normal, the sky is reflected with Fresnel's
// law. Short waves fade with distance before they could flicker.

#define HORIZON -0.05
#define FOCAL 1.25

float3 grade(float3 c) { return c * pick(1.0.xxx, float3(1.12, 0.96, 0.80), float3(0.82, 0.95, 1.12)); }

float3 sunDir() {
  float el = SUN * 0.5 + 0.015;
  return normalize(float3(0.34 * cos(el), sin(el), cos(el)));
}

float3 moonDir() { return normalize(float3(0.26, 0.2, 1.0)); }

float3 sunColor() { return lerp(float3(1.0, 0.42, 0.14), float3(1.0, 0.88, 0.72), ss(0.0, 0.5, SUN)); }

// sky without sun and moon discs: dark above, the light of the hour along the horizon
float3 skyColor(float3 d) {
  float e = max(d.y, 0.0);
  float day = ss(-0.1, 0.45, SUN);
  float3 zen = lerp(float3(0.0012, 0.002, 0.006), float3(0.012, 0.032, 0.09), day);
  float3 hor = lerp(float3(0.005, 0.008, 0.016), float3(0.07, 0.10, 0.14), day);
  zen = lerp(zen, float3(0.005, 0.010, 0.042), WARM * 0.85);
  hor = lerp(hor, float3(0.42, 0.15, 0.06), WARM);
  // the warm band hugs the horizon at dusk, the haze of day reaches higher
  float3 c = zen + (hor - zen) * exp(-e * lerp(5.0, 10.0, WARM));
  float3 s = sunDir();
  float sd = max(dot(d, s), 0.0);
  float up = ss(-0.12, 0.05, s.y);
  c += sunColor() * (pow(sd, 16.0) * 0.08 + pow(sd, 150.0) * 0.35) * up * (0.35 + 0.65 * WARM);
  float md = max(dot(d, moonDir()), 0.0);
  c += float3(0.30, 0.38, 0.55) * (pow(md, 60.0) * 0.06 + pow(md, 600.0) * 0.12) * NIGHT;
  return c;
}

float4 swell(float2 xz, float t, float fw) {
  // (height, slope x, slope z, unused) of six swells
  const float4 W[6] = {
    float4(0.16, 0.86, 0.90, 0.10), float4(-0.40, 0.92, 1.35, 0.055), float4(0.62, 0.78, 2.30, 0.03),
    float4(-0.78, 0.62, 3.70, 0.016), float4(0.28, 0.96, 6.20, 0.008), float4(-0.52, 0.85, 9.80, 0.0045) };
  float3 s = 0.0;
  [unroll] for (int i = 0; i < 6; i++) {
    float2 k = normalize(W[i].xy) * W[i].z;
    float a = W[i].w * ss(1.2, 0.25, W[i].z * fw);
    float w = sqrt(9.8 * W[i].z) * 0.45;
    float ph = dot(k, xz) - w * t + i * 1.7;
    s += float3(sin(ph), k * cos(ph)) * a;
  }
  return float4(s, 0.0);
}

float3 stars(float2 p) {
  float2 g = p * 40.0;
  float2 c = floor(g);
  float3 r = hash3(c);
  if (r.z > 0.4) return 0.0;
  float d = length(g - (c + 0.2 + 0.6 * r.xy)) / (40.0 * PX);
  return (0.04 + 0.8 * pow(r.z / 0.4, 8.0)) * exp(-d * d * 0.9) * float3(0.85, 0.9, 1.0);
}

float3 effect(float2 p, float t) {
  float3 d = normalize(float3(p.x, p.y - HORIZON, FOCAL));
  float3 c;
  float3 s = sunDir();
  float sunUp = ss(-0.06, 0.02, s.y);
  if (d.y >= 0.0) {
    c = skyColor(d);
    float sd = dot(d, s);
    c += sunColor() * ss(0.99984, 0.99992, sd) * 5.0 * sunUp;
    float md = dot(d, moonDir());
    c += float3(0.9, 0.92, 1.0) * ss(0.99988, 0.99994, md) * 0.9 * NIGHT;
    c += stars(p) * NIGHT * ss(0.02, 0.2, d.y);
    // a thin layer of cloud: dark against the sky, its edges lit towards the sun
    float2 q = d.xz / max(d.y, 0.02);
    float cloud = ss(0.0, 0.55, fbm3(q * float2(0.16, 0.5) + float2(t * 0.012, 0.0) + 3.0)) * ss(0.012, 0.06, d.y) * ss(0.5, 0.12, d.y);
    float3 shade = skyColor(d) * 0.4 + float3(0.002, 0.002, 0.004);
    float3 rim = sunColor() * pow(max(sd, 0.0), 5.0) * (0.06 + 0.4 * WARM) * sunUp + float3(0.03, 0.035, 0.05) * pow(max(md, 0.0), 8.0) * NIGHT;
    c = lerp(c, shade + rim, cloud * 0.85);
  } else {
    float dist = 1.0 / -d.y;
    float2 xz = d.xz * dist;
    float fw = length(fwidth(xz)) + 0.002;
    float4 w = swell(xz, t, fw);
    float3 n = normalize(float3(-w.y, 1.0, -w.z));
    float3 r = reflect(d, n);
    r.y = abs(r.y);
    float fres = 0.02 + 0.98 * pow(1.0 - saturate(dot(n, -d)), 5.0);
    float3 refl = skyColor(r);
    // the sun's (or moon's) path: wider and softer with distance, so it never sparkles
    float shine = lerp(900.0, 60.0, ss(0.0, 0.25, fw));
    refl += sunColor() * pow(max(dot(r, s), 0.0), shine) * shine * 0.012 * sunUp;
    refl += float3(0.7, 0.75, 0.85) * pow(max(dot(r, moonDir()), 0.0), shine * 0.6) * shine * 0.004 * NIGHT;
    float day = ss(-0.1, 0.45, SUN);
    float3 deep = lerp(float3(0.0006, 0.002, 0.004), float3(0.004, 0.022, 0.035), day);
    deep += float3(0.01, 0.03, 0.025) * max(w.x * 6.0, 0.0) * day; // light through the crests
    c = lerp(deep, refl, fres);
    c = lerp(c, skyColor(float3(d.x, 0.0, d.z)), 1.0 - exp(-dist * 0.012));
  }
  c = grade(c);
  float2 v = p / float2(max(ASPECT, 1.0), 1.0);
  c *= 1.0 - 0.3 * ss(0.35, 1.0, length(v));
  return encode(tonemap(c * 1.1));
}
