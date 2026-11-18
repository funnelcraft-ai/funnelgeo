const PATHS = {
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 19v-1a4 4 0 0 0-3-3.87M15.5 3.13a3.5 3.5 0 0 1 0 6.75',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
  building: 'M4 20V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v14M15 10h3a2 2 0 0 1 2 2v8M3 20h18M8 8h3M8 12h3M8 16h3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-3.6-3.6',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l4-4-4-4M14 12H4',
  upload: 'M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.500 5.6 12 3',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  play: 'M8 5.5v13l10.5-6.5z',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.5H15',
  chevron: 'M9 6l6 6-6 6',
  target: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 16.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zM12 12.5v-1',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14',
  key: 'M8 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11.5 11H21M18 11v3M15 11v2',
  gauge: 'M4.5 17a8.5 8.5 0 1 1 15 0M12 13l3.5-4M12 14.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3',
  layers: 'M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5',
  coins: 'M9 10a5 2.5 0 1 0 0-5 5 2.5 0 0 0 0 5M4 7.5v4C4 12.9 6.2 14 9 14s5-1.1 5-2.5v-4M10 17.5c.8 1 2.8 1.5 5 1.5 2.8 0 5-1.1 5-2.5v-4c0-1.4-2.2-2.5-5-2.5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
