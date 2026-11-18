import { SYMBOLS } from './symbols';

type Base<K> = K extends `${infer B}-fill` ? B : K;
export type IconName = Base<keyof typeof SYMBOLS>;

/** A Material Symbols Rounded icon. `filled` uses the filled version where there is one (active navigation). */
export function Icon({ name, filled = false, size }: { name: IconName; filled?: boolean; size?: number }) {
  const d = (filled && (SYMBOLS as Record<string, string>)[`${name}-fill`]) || SYMBOLS[name];
  return (
    <svg className="icon" viewBox="0 -960 960 960" aria-hidden="true" style={size ? { width: size, height: size } : undefined}>
      <path d={d} />
    </svg>
  );
}
