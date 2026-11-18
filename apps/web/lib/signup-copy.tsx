import type { AuthSection } from '@/components/AuthLayout';

/** The platform's own pitch, shown only on the platform's address (signup, home, admin sign-in). */
export const SIGNUP_SECTIONS: AuthSection[] = [
  {
    heading: 'Sell AI search visibility as your own service',
    points: [
      'Track what ChatGPT, Perplexity and Gemini tell your clients’ buyers, every week',
      'Fixes ranked by how many lost answers each one could win back',
      'Monthly reports with your logo, colours and domain, never ours',
    ],
  },
  {
    heading: 'What happens after you sign up?',
    points: [
      'Your workspace opens straight away at its own address',
      'Add your logo, brand colour and domain in Settings',
      'Add a client and the questions its buyers ask, then start the first check',
      'Invite your team, and give each client a read-only login',
    ],
  },
];
