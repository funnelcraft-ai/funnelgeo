import { WidgetForm } from '@/components/audits/WidgetForm';
import { getTenant } from '@/lib/server';

/** The form shown inside the agency's website. Framable; everything else is not. */
export default async function EmbedAuditPage() {
  const tenant = await getTenant();
  if (!tenant || tenant.kind !== 'agency') return null;
  if (!tenant.widgetEnabled || tenant.suspended) {
    return (
      <main className="embed">
        <p className="muted">This form is not available right now.</p>
      </main>
    );
  }
  return (
    <main className="embed">
      <WidgetForm agencyName={tenant.name} />
    </main>
  );
}
