import { createBrowserRouter, Link, Navigate, Outlet, useLocation, type RouteObject } from 'react-router-dom'
import { useOrganizations } from '@/api/queries'
import { FullPageSpinner } from '@/components/page'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { AppLayout } from '@/layouts/AppLayout'
import { useWorkspace } from '@/hooks/useWorkspace'
import { AccountPage } from '@/modules/account/AccountPage'
import { AppSettingsPage } from '@/modules/applications/AppSettingsPage'
import { ApplicationsPage } from '@/modules/applications/ApplicationsPage'
import { AcceptInvitePage } from '@/modules/auth/AcceptInvitePage'
import { LoginPage } from '@/modules/auth/LoginPage'
import { ForgotPasswordPage, ResetPasswordPage } from '@/modules/auth/PasswordPages'
import { RegisterPage } from '@/modules/auth/RegisterPage'
import { VerifyEmailPage, VerifyEmailSentPage } from '@/modules/auth/VerifyPages'
import { DashboardPage } from '@/modules/dashboard/DashboardPage'
import { RouteError } from '@/components/RouteError'
import { CampaignEditorPage } from '@/modules/email/CampaignEditorPage'
import { CampaignReportPage } from '@/modules/email/CampaignReportPage'
import { CampaignsPage, EmailOverviewPage, SendersPage, TemplateEditorPage, TemplatesPage } from '@/modules/email/EmailPages'
import { UnsubscribePage, VerifySenderPage } from '@/modules/email/PublicPages'
import { AudienceOverviewPage } from '@/modules/audience/AudienceOverviewPage'
import { ContactProfilePage } from '@/modules/audience/ContactProfilePage'
import { ContactsPage } from '@/modules/audience/ContactsPage'
import { ImportPage } from '@/modules/audience/ImportPage'
import { SegmentBuilderPage } from '@/modules/audience/SegmentBuilderPage'
import {
  FieldsPage,
  ListDetailPage,
  ListsPage,
  SegmentContactsPage,
  SegmentsPage,
  SuppressionPage,
  TagsPage,
} from '@/modules/audience/CollectionsPages'
import { DevMailboxPage } from '@/modules/dev/DevMailboxPage'
import { DevSmsOutboxPage } from '@/modules/dev/DevSmsOutboxPage'
import { DevCallLogPage } from '@/modules/dev/DevCallLogPage'
import { AutomationPage } from '@/modules/automation/AutomationPages'
import { AnalyticsPage } from '@/modules/analytics/AnalyticsPage'
import { BillingPage } from '@/modules/billing/BillingPage'
import { AdminPage } from '@/modules/admin/AdminPage'
import { WorkflowBuilderPage } from '@/modules/automation/WorkflowBuilderPage'
import { VoiceCampaignEditorPage } from '@/modules/voice/VoiceCampaignEditorPage'
import { VoiceReportPage } from '@/modules/voice/VoiceReportPage'
import { VoiceAudioPage, VoiceCallersPage, VoiceCampaignsPage, VoiceOverviewPage } from '@/modules/voice/VoicePages'
import { SmsCampaignEditorPage } from '@/modules/sms/SmsCampaignEditorPage'
import { SmsReportPage } from '@/modules/sms/SmsReportPage'
import { SmsCampaignsPage, SmsInboxPage, SmsOverviewPage, SmsRegistrationPage, SmsSendersPage, SmsTemplatesPage } from '@/modules/sms/SmsPages'
import { AuditLogPage } from '@/modules/organizations/AuditLogPage'
import { CreateApplicationPage, CreateOrganizationPage } from '@/modules/organizations/OnboardingPages'
import { OrgSettingsPage } from '@/modules/organizations/OrgSettingsPage'
import { TeamPage } from '@/modules/organizations/TeamPage'

function RequireAuth() {
  const { status } = useAuth()
  const location = useLocation()
  if (status === 'loading') return <FullPageSpinner />
  if (status === 'anonymous')
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return <Outlet />
}

function GuestOnly() {
  const { status } = useAuth()
  if (status === 'loading') return <FullPageSpinner />
  if (status === 'authenticated') return <Navigate to="/" replace />
  return <Outlet />
}

/** Sends a signed-in user to the right place: verification, onboarding or their last application. */
function HomeRedirect() {
  const { user } = useAuth()
  const orgs = useOrganizations()
  if (orgs.isLoading) return <FullPageSpinner />
  const list = orgs.data ?? []
  if (list.length === 0 && user?.platform_role) return <Navigate to="/admin" replace />
  if (list.length === 0) return <Navigate to={user?.email_verified ? '/onboarding/organization' : '/verify-email-sent'} replace />
  if (user?.last_application_id) return <Navigate to={`/apps/${user.last_application_id}`} replace />
  const org = list.find((o) => o.id === user?.last_organization_id) ?? list[0]!
  if (org.application_count === 0 && org.permissions.includes('apps.create'))
    return <Navigate to={`/onboarding/application?org=${org.id}`} replace />
  return <Navigate to={`/orgs/${org.id}/applications`} replace />
}

/** App-scoped pages need a resolved application. */
function AppScoped({ children }: { children: React.ReactNode }) {
  const { app } = useWorkspace()
  return app ? <>{children}</> : <FullPageSpinner />
}

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-semibold text-primary">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you're looking for doesn't exist or has moved.</p>
      <Button asChild className="mt-3">
        <Link to="/">Back to workspace</Link>
      </Button>
    </div>
  )
}

const routes: RouteObject[] = [
  {
    element: <GuestOnly />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
    ],
  },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  { path: '/invite', element: <AcceptInvitePage /> },
  { path: '/dev/mailbox', element: <DevMailboxPage /> },
  { path: '/dev/sms', element: <DevSmsOutboxPage /> },
  { path: '/dev/calls', element: <DevCallLogPage /> },
  { path: '/verify-sender', element: <VerifySenderPage /> },
  { path: '/unsubscribe', element: <UnsubscribePage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <HomeRedirect /> },
      { path: '/verify-email-sent', element: <VerifyEmailSentPage /> },
      { path: '/onboarding/organization', element: <CreateOrganizationPage /> },
      { path: '/onboarding/application', element: <CreateApplicationPage /> },
      {
        element: <AppLayout />,
        children: [
          { path: '/apps/:appId', element: <AppScoped><DashboardPage /></AppScoped> },
          { path: '/apps/:appId/settings', element: <AppScoped><AppSettingsPage /></AppScoped> },
          { path: '/apps/:appId/audience', element: <AppScoped><AudienceOverviewPage /></AppScoped> },
          { path: '/apps/:appId/audience/contacts', element: <AppScoped><ContactsPage /></AppScoped> },
          { path: '/apps/:appId/audience/contacts/:contactId', element: <AppScoped><ContactProfilePage /></AppScoped> },
          { path: '/apps/:appId/audience/segments', element: <AppScoped><SegmentsPage /></AppScoped> },
          { path: '/apps/:appId/audience/segments/new', element: <AppScoped><SegmentBuilderPage /></AppScoped> },
          { path: '/apps/:appId/audience/segments/:segmentId', element: <AppScoped><SegmentBuilderPage /></AppScoped> },
          { path: '/apps/:appId/audience/segments/:segmentId/contacts', element: <AppScoped><SegmentContactsPage /></AppScoped> },
          { path: '/apps/:appId/audience/lists', element: <AppScoped><ListsPage /></AppScoped> },
          { path: '/apps/:appId/audience/lists/:listId', element: <AppScoped><ListDetailPage /></AppScoped> },
          { path: '/apps/:appId/audience/tags', element: <AppScoped><TagsPage /></AppScoped> },
          { path: '/apps/:appId/audience/fields', element: <AppScoped><FieldsPage /></AppScoped> },
          { path: '/apps/:appId/audience/import', element: <AppScoped><ImportPage /></AppScoped> },
          { path: '/apps/:appId/audience/import/:importId', element: <AppScoped><ImportPage /></AppScoped> },
          { path: '/apps/:appId/audience/suppression', element: <AppScoped><SuppressionPage /></AppScoped> },
          { path: '/apps/:appId/email', element: <AppScoped><EmailOverviewPage /></AppScoped> },
          { path: '/apps/:appId/email/campaigns', element: <AppScoped><CampaignsPage /></AppScoped> },
          { path: '/apps/:appId/email/campaigns/:campaignId', element: <AppScoped><CampaignReportPage /></AppScoped> },
          { path: '/apps/:appId/email/campaigns/:campaignId/edit', element: <AppScoped><CampaignEditorPage /></AppScoped> },
          { path: '/apps/:appId/email/templates', element: <AppScoped><TemplatesPage /></AppScoped> },
          { path: '/apps/:appId/email/templates/:templateId', element: <AppScoped><TemplateEditorPage /></AppScoped> },
          { path: '/apps/:appId/email/senders', element: <AppScoped><SendersPage /></AppScoped> },
          { path: '/apps/:appId/sms', element: <AppScoped><SmsOverviewPage /></AppScoped> },
          { path: '/apps/:appId/sms/campaigns', element: <AppScoped><SmsCampaignsPage /></AppScoped> },
          { path: '/apps/:appId/sms/campaigns/:campaignId', element: <AppScoped><SmsReportPage /></AppScoped> },
          { path: '/apps/:appId/sms/campaigns/:campaignId/edit', element: <AppScoped><SmsCampaignEditorPage /></AppScoped> },
          { path: '/apps/:appId/sms/templates', element: <AppScoped><SmsTemplatesPage /></AppScoped> },
          { path: '/apps/:appId/sms/senders', element: <AppScoped><SmsSendersPage /></AppScoped> },
          { path: '/apps/:appId/sms/registration', element: <AppScoped><SmsRegistrationPage /></AppScoped> },
          { path: '/apps/:appId/sms/inbox', element: <AppScoped><SmsInboxPage /></AppScoped> },
          { path: '/apps/:appId/voice', element: <AppScoped><VoiceOverviewPage /></AppScoped> },
          { path: '/apps/:appId/voice/campaigns', element: <AppScoped><VoiceCampaignsPage /></AppScoped> },
          { path: '/apps/:appId/voice/campaigns/:campaignId', element: <AppScoped><VoiceReportPage /></AppScoped> },
          { path: '/apps/:appId/voice/campaigns/:campaignId/edit', element: <AppScoped><VoiceCampaignEditorPage /></AppScoped> },
          { path: '/apps/:appId/voice/audio', element: <AppScoped><VoiceAudioPage /></AppScoped> },
          { path: '/apps/:appId/voice/callers', element: <AppScoped><VoiceCallersPage /></AppScoped> },
          { path: '/apps/:appId/automation', element: <AppScoped><AutomationPage /></AppScoped> },
          { path: '/apps/:appId/analytics', element: <AppScoped><AnalyticsPage /></AppScoped> },
          { path: '/apps/:appId/billing', element: <AppScoped><BillingPage scope="app" /></AppScoped> },
          { path: '/apps/:appId/automation/:workflowId', element: <AppScoped><WorkflowBuilderPage /></AppScoped> },
          { path: '/orgs/:orgId/applications', element: <ApplicationsPage /> },
          { path: '/orgs/:orgId/team', element: <TeamPage /> },
          { path: '/orgs/:orgId/settings', element: <OrgSettingsPage /> },
          { path: '/orgs/:orgId/audit-log', element: <AuditLogPage /> },
          { path: '/orgs/:orgId/billing', element: <BillingPage scope="org" /> },
          { path: '/account', element: <AccountPage /> },
          { path: '/admin', element: <AdminPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]

export const router = createBrowserRouter([{ errorElement: <RouteError />, children: routes }])
