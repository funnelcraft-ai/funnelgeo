import {
  argbFromHex,
  Contrast,
  DynamicScheme,
  Hct,
  hexFromArgb,
  SchemeMonochrome,
  SchemeTonalSpot,
  TonalPalette,
  Variant,
} from '@material/material-color-utilities';

/**
 * Material 3 colour roles as CSS custom properties (--md-sys-color-*).
 *
 * FunnelGeo's own pages, and agencies with no brand colour, use a charcoal
 * monochrome scheme taken from the Funnelcraft wordmark. An agency with a
 * brand colour gets a tonal-spot scheme generated from it (soft surfaces and
 * containers), with the primary roles built from the brand's own chroma so
 * buttons stay on brand: the brand colour itself is the primary when white
 * text is readable on it. An accent colour, if set, becomes the tertiary
 * palette. Uses the 2025 (Material 3 Expressive) colour spec.
 */

export const PLATFORM_SEED = '#1d2024';

const ROLES = [
  'primary', 'onPrimary', 'primaryContainer', 'onPrimaryContainer',
  'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer',
  'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer',
  'error', 'onError', 'errorContainer', 'onErrorContainer',
  'background', 'onBackground', 'surface', 'surfaceDim', 'surfaceBright',
  'surfaceContainerLowest', 'surfaceContainerLow', 'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest',
  'onSurface', 'surfaceVariant', 'onSurfaceVariant', 'inverseSurface', 'inverseOnSurface', 'inversePrimary',
  'outline', 'outlineVariant', 'shadow', 'scrim',
] as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const HEX = /^#[0-9a-f]{6}$/i;

/** Success and warning aren't Material roles; they're built the same way from fixed hues. */
function statusRoles(seed: string, name: string): Record<string, string> {
  // Chroma capped so status containers sit quietly beside any brand.
  const hct = Hct.fromInt(argbFromHex(seed));
  const p = TonalPalette.fromHueAndChroma(hct.hue, Math.min(hct.chroma, 40));
  const soft = TonalPalette.fromHueAndChroma(hct.hue, Math.min(hct.chroma, 24));
  return {
    [`--md-sys-color-${name}`]: hexFromArgb(p.tone(40)),
    [`--md-sys-color-on-${name}`]: hexFromArgb(p.tone(100)),
    [`--md-sys-color-${name}-container`]: hexFromArgb(soft.tone(93)),
    [`--md-sys-color-on-${name}-container`]: hexFromArgb(p.tone(25)),
  };
}

export function themeVars(primaryColor?: string | null, accentColor?: string | null): Record<string, string> {
  let scheme: DynamicScheme;
  if (primaryColor && HEX.test(primaryColor)) {
    const source = Hct.fromInt(argbFromHex(primaryColor));
    const base = new SchemeTonalSpot(source, false, 0, '2025');
    scheme =
      accentColor && HEX.test(accentColor)
        ? new DynamicScheme({
            sourceColorHct: source,
            variant: Variant.TONAL_SPOT,
            contrastLevel: 0,
            isDark: false,
            specVersion: '2025',
            primaryPalette: base.primaryPalette,
            secondaryPalette: base.secondaryPalette,
            tertiaryPalette: TonalPalette.fromInt(argbFromHex(accentColor)),
            neutralPalette: base.neutralPalette,
            neutralVariantPalette: base.neutralVariantPalette,
          })
        : base;
  } else {
    scheme = new SchemeMonochrome(Hct.fromInt(argbFromHex(PLATFORM_SEED)), false, 0, '2025');
  }

  const vars: Record<string, string> = {};
  for (const role of ROLES) vars[`--md-sys-color-${kebab(role)}`] = hexFromArgb((scheme as unknown as Record<string, number>)[role]!);
  if (primaryColor && HEX.test(primaryColor)) {
    const brand = argbFromHex(primaryColor);
    const p = TonalPalette.fromInt(brand);
    const white = argbFromHex('#ffffff');
    const readable = Contrast.ratioOfTones(Hct.fromInt(brand).tone, 100) >= 4.5;
    Object.assign(vars, {
      '--md-sys-color-primary': readable ? primaryColor.toLowerCase() : hexFromArgb(p.tone(40)),
      '--md-sys-color-on-primary': hexFromArgb(white),
      '--md-sys-color-primary-container': hexFromArgb(p.tone(90)),
      '--md-sys-color-on-primary-container': hexFromArgb(p.tone(25)),
      '--md-sys-color-inverse-primary': hexFromArgb(p.tone(80)),
    });
  } else {
    // Monochrome makes the primary pure black; the wordmark's charcoal reads softer.
    vars['--md-sys-color-primary'] = PLATFORM_SEED;
    vars['--md-sys-color-on-primary'] = '#ffffff';
    vars['--md-sys-color-secondary-container'] = vars['--md-sys-color-surface-container-highest']!;
    // Monochrome containers are dark by design; light ones match how every other scheme reads.
    vars['--md-sys-color-primary-container'] = '#e4e5e7';
    vars['--md-sys-color-on-primary-container'] = '#1d2024';
    vars['--md-sys-color-inverse-primary'] = '#c4c6c9';
  }
  Object.assign(vars, statusRoles('#1e8e3e', 'success'), statusRoles('#b26a00', 'warning'));
  // Error keeps the scheme's own role, with a quieter container for badges.
  const err = statusRoles('#ba1a1a', 'error');
  vars['--md-sys-color-error-container'] = err['--md-sys-color-error-container']!;
  vars['--md-sys-color-on-error-container'] = err['--md-sys-color-on-error-container']!;
  return vars;
}
