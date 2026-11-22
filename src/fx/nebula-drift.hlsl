// Nebula Drift: glowing gas, dark dust lanes and stars drifting slowly past.
//
// The gas is a fractal noise field bent by two more (domain warping); its brightness grows
// exponentially with density, so it has bright cores and soft edges. Ridged noise adds thin
// filaments, another field carves the dust lanes. Stars lie on three depths that drift at
// different speeds, so the cloud has depth without any geometry.

float3 gasA() { return pick(float3(0.04, 0.58, 0.68), float3(1.00, 0.58, 0.14), float3(0.10, 0.42, 1.00)); }
float3 gasM() { return pick(float3(0.26, 0.12, 0.80), float3(0.90, 0.26, 0.10), float3(0.30, 0.14, 0.95)); }
float3 gasB() { return pick(float3(0.92, 0.14, 0.40), float3(0.70, 0.08, 0.10), float3(0.70, 0.18, 0.85)); }

// through a third colour, so the mix never turns grey
float3 gasColor(float h) { return h < 0.5 ? lerp(gasA(), gasM(), h * 2.0) : lerp(gasM(), gasB(), h * 2.0 - 1.0); }

// one depth of stars: cells of 1/scale, a star in some of them
float3 starLayer(float2 q, float scale, float chance, float bright, float spikes) {
  float2 g = q * scale;
  float2 c = floor(g);
  float3 r = hash3(c + scale);
  if (r.z > chance) return 0.0;
  float2 d = (g - (c + 0.2 + 0.6 * r.xy)) / (scale * PX);
  float l = length(d);
  float k = pow(r.z / chance, 5.0);
  float b = bright * (0.12 + k);
  float3 tint = lerp(float3(0.70, 0.80, 1.00), float3(1.00, 0.86, 0.70), r.x);
  float s = exp(-l * l * 0.8) + 0.06 * k * exp(-l * 0.4);
  // the brightest get faint four-point spikes
  s += spikes * k * (exp(-abs(d.x) * 1.4) * exp(-abs(d.y) * 0.16) + exp(-abs(d.y) * 1.4) * exp(-abs(d.x) * 0.16)) * 0.18;
  return tint * b * s;
}

float3 effect(float2 p, float t) {
  float2 drift = float2(t * 0.0042, t * 0.0011);
  float2 q = p * 1.25 + drift + float2(3.1, 1.7);
  float2 w = float2(fbm3(q * 0.6 + float2(0.0, t * 0.0030)), fbm3(q * 0.6 + float2(5.2, 1.3) - float2(t * 0.0024, 0.0)));
  float2 r = q + 0.9 * w;
  float density = fbm5(r * 1.2);
  float hue = ss(-0.4, 0.4, fbm3(r * 0.7 + 7.0));
  float ridge = saturate(1.0 - abs(fbm3(r * 1.9 + w * 0.8 + 3.3)));
  float dust = ss(0.1, 0.6, fbm3(r * 2.4 + w * 1.6 + 11.0));

  // the cloud lies in a broad band from the lower left to the upper right, densest right of centre
  float band = dot(p - float2(0.3, 0.0), float2(0.42, -0.91)) + 0.15 * w.x;
  float envelope = exp(-band * band * 5.0) * ss(-1.0, 0.4, p.x);

  float gas = max(exp(2.8 * density) - 0.55, 0.0) * envelope;
  float filaments = pow(ridge, 9.0) * ss(-0.3, 0.4, density) * envelope;
  float3 col = gasColor(hue);
  float3 c = col * gas * 0.09;
  c += lerp(col, 1.0.xxx, 0.3) * filaments * 0.3;
  c *= 1.0 - 0.85 * dust;
  // faint scattered light around the band, and the dark of space
  c += gasM() * 0.008 * (envelope + 0.15);
  c += float3(0.0010, 0.0013, 0.0035);

  float veil = 1.0 - 0.75 * dust * ss(0.0, 0.5, envelope);
  c += starLayer(p + drift * 1.15, 64.0, 0.15, 0.2, 0.0) * veil;
  c += starLayer(p + drift * 1.40, 24.0, 0.22, 0.55, 0.0) * veil;
  c += starLayer(p + drift * 1.80, 8.0, 0.14, 1.4, 1.0);

  c = daytint(c, 0.5, 0.18);
  float2 v = p / float2(max(ASPECT, 1.0), 1.0);
  c *= 1.0 - 0.3 * ss(0.35, 1.0, length(v));
  return encode(tonemapHue(c * 1.2));
}
