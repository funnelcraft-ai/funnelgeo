import { ResetForm } from '@/components/AuthForms';
import { AuthCardHead, AuthLayout } from '@/components/AuthLayout';
import { apiGet, getTenant } from '@/lib/server';

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const tenant = await getTenant();
  if (!tenant) return null;
  const { token } = await params;
  const data = await apiGet<{ email: string }>(`/v1/auth/reset/${encodeURIComponent(token)}`);

  return (
    <AuthLayout
      tenant={tenant}
      headline={<>Back in, in a moment.</>}
      card={
        data ? (
          <>
            <AuthCardHead title="Choose a new password" sub="You’ll be signed in as soon as it’s saved." />
            <ResetForm token={token} email={data.email} next={tenant.kind === 'platform' ? '/admin' : '/clients'} />
          </>
        ) : (
          <>
            <AuthCardHead title="This link is no longer valid" sub="Reset links work once and expire after an hour. Request a new one to continue." />
            <a className="button block" href="/forgot">Request a new link</a>
          </>
        )
      }
    />
  );
}
