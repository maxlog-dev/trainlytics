/**
 * The launch placeholder, rendered while auth resolves so React's first commit
 * doesn't replace the inline one with an empty page. Same markup and id as
 * `#boot-splash` in index.html, which its inline #boot-style styles, so the
 * logo doesn't move; BootSplash.test.tsx keeps the two identical (the iOS
 * launch images are screenshots of that markup).
 */
export function BootSplash() {
  return (
    <div id="boot-splash">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 4 156 48" fill="none" role="img" aria-label="Trainlytics">
        <rect x="4" y="28" width="8" height="20" rx="2" fill="#B8C9B2" />
        <rect x="16" y="18" width="8" height="30" rx="2" fill="#7E9B76" />
        <rect x="28" y="8" width="8" height="40" rx="2" fill="#4F6B52" />
        <text
          x="46"
          y="35"
          fontFamily="Montserrat, system-ui, sans-serif"
          fontWeight="700"
          fontSize="20"
          fill="#2F342F"
          letterSpacing="-0.5"
        >
          Trainlytics
        </text>
      </svg>
    </div>
  )
}
