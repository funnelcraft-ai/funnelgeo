import { notFound } from 'next/navigation';
import { ClientWorkspace } from '@/components/workspace/ClientWorkspace';
import { apiGet, getSession } from '@/lib/server';
import type { Run, Tracker, Visibility } from '@/lib/types';

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return null; // the layout redirects
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [tracker, latest] = await Promise.all([
    apiGet<Tracker>(`/v1/clients/${id}/tracker`),
    apiGet<{ run: Run | null; visibility: Visibility | null }>(`/v1/clients/${id}/visibility`),
  ]);
  if (!tracker) notFound();

  return (
    <ClientWorkspace
      initial={tracker}
      initialRun={latest?.run ?? null}
      initialVisibility={latest?.visibility ?? null}
      canEdit={session.user.role !== 'client_viewer'}
    />
  );
}
