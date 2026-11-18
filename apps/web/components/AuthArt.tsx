/**
 * Line drawing for the top of the sign-in pages: an answer engine's chat,
 * a magnifier over a cited source, and a rising trend. Original artwork,
 * drawn in the page's ink colour so it suits any agency's brand.
 */
export function AuthArt() {
  return (
    <svg className="auth-art" viewBox="0 0 720 300" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {/* Question bubble */}
        <path d="M118 66h196a18 18 0 0 1 18 18v40a18 18 0 0 1-18 18H178l-26 22v-22h-34a18 18 0 0 1-18-18V84a18 18 0 0 1 18-18z" />
        <path d="M128 92h120M128 112h168" />
        <circle cx="306" cy="92" r="3" fill="currentColor" />
        {/* Answer bubble, with a highlighted mention */}
        <path d="M302 158h262a20 20 0 0 1 20 20v70a20 20 0 0 1-20 20h-52v24l-28-24H302a20 20 0 0 1-20-20v-70a20 20 0 0 1 20-20z" />
        <path d="M304 186h68M384 186h120M304 208h40" />
        <rect x="352" y="198" width="104" height="20" rx="10" />
        <path d="M466 208h88M304 230h150M466 230h56M304 250h96" />
        <path d="M359 211l4 4 8-9" />
        {/* Hatching on the answer bubble's shadow edge */}
        <path d="M586 186l10-10M586 204l12-12M586 222l14-14M586 240l14-14M586 258l12-12M580 276l14-14" strokeWidth="1.4" opacity="0.6" />
        {/* Source card behind a magnifier */}
        <path d="M486 34h138a12 12 0 0 1 12 12v68a12 12 0 0 1-12 12H486a12 12 0 0 1-12-12V46a12 12 0 0 1 12-12z" />
        <path d="M492 56h56M492 74h100M492 92h76" />
        <circle cx="600" cy="70" r="30" />
        <path d="M621 91l28 28" strokeWidth="6" />
        <path d="M585 66l9 9 18-20" />
        {/* Rising trend with points */}
        <path d="M20 268l46-30 40 14 48-46 42 10 46-48" />
        <circle cx="66" cy="238" r="5" fill="var(--auth-art-fill, #fff)" />
        <circle cx="106" cy="252" r="5" fill="var(--auth-art-fill, #fff)" />
        <circle cx="154" cy="206" r="5" fill="var(--auth-art-fill, #fff)" />
        <circle cx="196" cy="216" r="5" fill="var(--auth-art-fill, #fff)" />
        <circle cx="242" cy="168" r="6" fill="currentColor" />
        <path d="M20 284h236" strokeWidth="1.4" opacity="0.6" />
        {/* Sparkles */}
        <path d="M402 44v24M390 56h24" />
        <path d="M682 168v16M674 176h16" />
        <path d="M60 104v18M51 113h18" />
        <path d="M426 112l6 6M438 100l-4 4" strokeWidth="1.6" />
        <circle cx="700" cy="40" r="3" />
        <circle cx="36" cy="54" r="3" />
      </g>
    </svg>
  );
}
