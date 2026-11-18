import type { ReactNode } from 'react';
import { AuthArt } from './AuthArt';
import { Brand } from './Brand';
import { Icon } from './Icon';
import type { Tenant } from '@/lib/types';

export interface AuthSection {
  heading: ReactNode;
  points: ReactNode[];
}

/**
 * Signed-out pages: a light band with a line drawing, the headline and what
 * the visitor gets on the left, and the form in a raised card on the right.
 * On an agency's address everything shown is the agency's own.
 */
export function AuthLayout({
  tenant,
  headline,
  sections = [],
  card,
}: {
  tenant: Tenant;
  headline: ReactNode;
  sections?: AuthSection[];
  card: ReactNode;
}) {
  return (
    <div className="auth">
      <div className="auth-band">
        <AuthArt />
      </div>
      <main className="auth-sheet">
        <div className="auth-top">
          <Brand tenant={tenant} href="/" />
        </div>
        <div className="auth-grid">
          <div className="auth-copy">
            <h1 className="auth-headline">{headline}</h1>
            {sections.map((s, i) => (
              <section key={i} className="auth-section">
                <h2>{s.heading}</h2>
                <ul>
                  {s.points.map((p, j) => (
                    <li key={j}>
                      <span className="auth-check"><Icon name="check" size={18} /></span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="auth-form-card">{card}</div>
        </div>
      </main>
    </div>
  );
}

/** Card header: title, with an optional link to the other form at the top right. */
export function AuthCardHead({ title, sub, alt }: { title: string; sub?: ReactNode; alt?: { href: string; label: string } }) {
  return (
    <div className="auth-card-head">
      {alt && <a className="auth-alt" href={alt.href}>{alt.label}</a>}
      <h2>{title}</h2>
      {sub && <p className="muted">{sub}</p>}
    </div>
  );
}

/** What agency staff and their clients see on an agency's own sign-in page. Nothing names the platform. */
export const AGENCY_SECTIONS: AuthSection[] = [
  {
    heading: 'Everything in one place',
    points: [
      'Weekly checks of what ChatGPT, Perplexity and Gemini say when buyers ask',
      'The sources behind each answer, and the fixes that matter most',
      'Monthly reports with the results, ready to share',
    ],
  },
];
