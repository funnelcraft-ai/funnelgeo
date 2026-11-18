import { AcceptInviteForm } from '@/components/AuthForms';
import { AGENCY_SECTIONS, AuthCardHead, AuthLayout } from '@/components/AuthLayout';
import { apiGet, getTenant } from '@/lib/server';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const tenant = await getTenant();
  if (!tenant) return null;
  const { token } = await params;
  const data = await apiGet<{ invite: { email: string } }>(`/v1/invites/${encodeURIComponent(token)}`);

  return (
    <AuthLayout
      tenant={tenant}
      headline={<>You’re invited to {tenant.name}.</>}
      sections={tenant.kind === 'agency' ? AGENCY_SECTIONS : []}
      card={
        data ? (
          <>
            <AuthCardHead title={`Join ${tenant.name}`} sub="Set your name and a password to get started." />
            <AcceptInviteForm token={token} email={data.invite.email} />
          </>
        ) : (
          <>
            <AuthCardHead title="This invite is no longer valid" sub="It may have expired or already been used. Ask for a new invite, or sign in if you already have an account." />
            <a className="button block" href="/login">Go to sign in</a>
          </>
        )
      }
    />
  );
}
