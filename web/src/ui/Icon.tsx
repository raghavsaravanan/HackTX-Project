const PATHS = {
  eye: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  spark: "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6.3 6.3l2.5 2.5 M15.2 15.2l2.5 2.5 M6.3 17.7l2.5-2.5 M15.2 8.8l2.5-2.5",
  compass: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M15.5 8.5l-2 5-5 2 2-5 5-2Z",
  map: "M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z M9 4v14 M15 6v14",
  flow: "M5 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M19 21.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M5 6.5v4a3 3 0 0 0 3 3h8a3 3 0 0 1 3 3v1",
  phone: "M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5Z M11 18.5h2",
  mic: "M12 14.5a3 3 0 0 0 3-3v-5a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z M18.5 11.5a6.5 6.5 0 0 1-13 0 M12 18v3",
  shield: "M12 21s7.5-3.5 7.5-9.5V5.5L12 3 4.5 5.5v6C4.5 17.5 12 21 12 21Z M9 12l2 2 4-4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  back: "M19 12H5 M11 6l-6 6 6 6",
  volume: "M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z M15.5 9a4 4 0 0 1 0 6 M18 6.5a7.5 7.5 0 0 1 0 11",
  mute: "M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z M16 9.5l5 5 M21 9.5l-5 5",
  send: "M4 12 20 4l-4.5 16-3.5-6.5L4 12Z M12 13.5 20 4",
  alert: "M12 4 2.8 19.5h18.4L12 4Z M12 10v4 M12 17h.01",
  hand: "M8 12V5.5a1.5 1.5 0 0 1 3 0V11 M11 10.5v-6a1.5 1.5 0 0 1 3 0v6 M14 10.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3 15.5a1.6 1.6 0 0 1 2.4-2L8 15.5",
  heart: "M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.5 4.3 4.3 0 0 1 19.5 10C19.5 15.4 12 20 12 20Z",
  wave: "M3 12h2 M7 8v8 M11 5v14 M15 8v8 M19 10.5v3 M21 12h0",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M12 12h.01",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "icon" }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}
