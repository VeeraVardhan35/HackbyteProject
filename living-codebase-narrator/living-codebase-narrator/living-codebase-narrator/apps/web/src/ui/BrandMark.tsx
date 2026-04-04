type BrandMarkProps = {
  className?: string;
  compact?: boolean;
};

export function BrandMark({ className, compact = false }: BrandMarkProps) {
  return (
    <div className={className ? `brandLockup ${className}` : 'brandLockup'}>
      <svg className="brandGlyph" viewBox="0 0 128 128" aria-hidden="true">
        <defs>
          <linearGradient id="brandCore" x1="22" y1="18" x2="102" y2="108" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#6cf2ff" />
            <stop offset="0.55" stopColor="#4cb8ff" />
            <stop offset="1" stopColor="#97ffba" />
          </linearGradient>
          <linearGradient id="brandPulse" x1="32" y1="28" x2="98" y2="102" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fef7c8" />
            <stop offset="1" stopColor="#84ffd4" />
          </linearGradient>
        </defs>
        <rect x="18" y="16" width="92" height="96" rx="24" fill="rgba(9,20,31,0.86)" />
        <rect x="18" y="16" width="92" height="96" rx="24" stroke="url(#brandCore)" strokeWidth="8" />
        <path
          d="M42 42h22c15.464 0 28 12.536 28 28s-12.536 28-28 28H42V42Z"
          fill="url(#brandCore)"
          opacity="0.18"
        />
        <path
          d="M44 43.5h16.5c14.635 0 26.5 11.865 26.5 26.5S75.135 96.5 60.5 96.5H44V43.5Z"
          stroke="url(#brandCore)"
          strokeWidth="7"
          strokeLinejoin="round"
        />
        <path d="M56 54h17" stroke="url(#brandPulse)" strokeWidth="7" strokeLinecap="round" />
        <path d="M56 70h25" stroke="url(#brandPulse)" strokeWidth="7" strokeLinecap="round" />
        <path d="M56 86h14" stroke="url(#brandPulse)" strokeWidth="7" strokeLinecap="round" />
        <circle cx="91" cy="36" r="7" fill="#f8c86f" />
      </svg>

      {!compact ? (
        <div className="brandText">
          <span className="brandName">Living Codebase Narrator</span>
          <span className="brandTagline">Real-time repo memory for teams that ship fast.</span>
        </div>
      ) : null}
    </div>
  );
}
