import { createBrowserRouter, Link, Navigate, Outlet, useLocation, type RouteObject } from 'react-router-dom'
import { useOrganizations } from '@/api/queries'
import { FullPageSpinner } from '@/components/page'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'
import { AdminGuard, CrmCrumbs } from './layoutRoutes'
import { RouteError } from '@/components/RouteError'
import {
  AcceptInvitePage, AccountPage, AnalyticsPage, AppLayout, HomePage, MarketingLayout, PricingPage, ProductPage, LoginPage, ApplicationsPage, AppSettingsPage, AudienceOverviewPage, AuditLogPage, AutomationPage, BillingPage,
  CampaignEditorPage, CampaignReportPage, CampaignsPage, ChatAnalyticsPage, ChatBotEditorPage, ChatBotsPage, ChatInboxPage, CompaniesPage,
  CompanyDetailPage, ContactProfilePage, ContactsPage, CreateApplicationPage, CreateOrganizationPage, CrmSettingsPage, DashboardPage, DealDetailPage,
  DealsPage, DevCallLogPage, DevMailboxPage, DevSmsOutboxPage, EmailOverviewPage, FieldsPage, ForgotPasswordPage, FormDetailPage, FormsPage,
  ImportPage, LeadsPage, ListDetailPage, ListsPage, NewCampaignRoute, NewWorkflowFromLinkPage, OrgSettingsPage, RegisterPage, ReportsPage,
  ResetPasswordPage, SegmentBuilderPage, SegmentContactsPage, SegmentsPage, SendersPage, SmsComingSoonPage,
  SmsRegistrationPage, SuppressionPage, TagsPage, TasksPage, TeamPage,
  TemplateEditorPage, TemplatesPage, UnsubscribePage, VerifyEmailPage, VerifyEmailSentPage, VerifySenderPage, VoiceAgentEditorPage, VoiceAgentsPage,
  VoiceAudioPage, VoiceCampaignEditorPage, VoiceCampaignsPage, VoiceOverviewPage, VoiceReportPage, WorkflowBuilderPage,
  SuspenseOutlet, AgentsPage, AgentDetailPage, ApprovalsPage, IntegrationsPage, DevSlackLogPage,
} from './pages'

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

/**
 * The public marketing site's layout route. "/" is the home page for visitors and the workspace for people
 * who are signed in; /welcome, /pricing and /products/* are public for everyone. The marketing chunk is
 * not downloaded when "/" redirects a signed-in user.
 */
function HomeGate() {
  const { status } = useAuth()
  const { pathname } = useLocation()
  if (pathname === '/') {
    if (status === 'loading') return <FullPageSpinner />
    if (status === 'authenticated') return <HomeRedirect />
  }
  return <MarketingLayout />
}

/** App-scoped pages need a resolved application. */
function AppScoped({ children }: { children: React.ReactNode }) {
  const { app } = useWorkspace()
  return app ? <>{children}</> : <FullPageSpinner />
}

/**
 * The old per-application billing address. Billing now lives in one place (the organization), so this
 * opens it filtered to the application, or the application overview (with its usage card) for people
 * who can see only this application.
 */
function AppBillingRedirect() {
  const { app, org, canOrg } = useWorkspace()
  if (!app || !org) return <FullPageSpinner />
  return <Navigate to={canOrg('billing.read') ? `/orgs/${org.id}/billing?app=${app.id}` : `/apps/${app.id}`} replace />
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
  { path: '/dev/slack', element: <DevSlackLogPage /> },
  { path: '/verify-sender', element: <VerifySenderPage /> },
  { path: '/unsubscribe', element: <UnsubscribePage /> },
  {
    element: <HomeGate />,
    children: [
      { path: '/', element: <HomePage /> },
      // The home page, even when signed in (preview, sharing).
      { path: '/welcome', element: <HomePage /> },
      { path: '/pricing', element: <PricingPage /> },
      { path: '/products/:slug', element: <ProductPage /> },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      { path: '/verify-email-sent', element: <VerifyEmailSentPage /> },
      { path: '/onboarding/organization', element: <CreateOrganizationPage /> },
      { path: '/onboarding/application', element: <CreateApplicationPage /> },
      {
        element: <AppLayout />,
        // Pages load lazily inside the layout, so the sidebar and header stay while a page's chunk loads.
        children: [{ element: <SuspenseOutlet />, children: [
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
          { path: '/apps/:appId/email/campaigns/new', element: <AppScoped><NewCampaignRoute channel="email" /></AppScoped> },
          { path: '/apps/:appId/email/campaigns/:campaignId', element: <AppScoped><CampaignReportPage /></AppScoped> },
          { path: '/apps/:appId/email/campaigns/:campaignId/edit', element: <AppScoped><CampaignEditorPage /></AppScoped> },
          { path: '/apps/:appId/email/templates', element: <AppScoped><TemplatesPage /></AppScoped> },
          { path: '/apps/:appId/email/templates/:templateId', element: <AppScoped><TemplateEditorPage /></AppScoped> },
          { path: '/apps/:appId/email/senders', element: <AppScoped><SendersPage /></AppScoped> },
          // SMS is coming soon in every market: every SMS route shows one coming-soon page.
          { path: '/apps/:appId/sms', element: <AppScoped><SmsComingSoonPage /></AppScoped> },
          { path: '/apps/:appId/sms/*', element: <AppScoped><SmsComingSoonPage /></AppScoped> },
          { path: '/apps/:appId/voice', element: <AppScoped><VoiceOverviewPage /></AppScoped> },
          { path: '/apps/:appId/voice/campaigns', element: <AppScoped><VoiceCampaignsPage /></AppScoped> },
          { path: '/apps/:appId/voice/campaigns/new', element: <AppScoped><NewCampaignRoute channel="voice" /></AppScoped> },
          { path: '/apps/:appId/voice/campaigns/:campaignId', element: <AppScoped><VoiceReportPage /></AppScoped> },
          { path: '/apps/:appId/voice/campaigns/:campaignId/edit', element: <AppScoped><VoiceCampaignEditorPage /></AppScoped> },
          { path: '/apps/:appId/voice/audio', element: <AppScoped><VoiceAudioPage /></AppScoped> },
          // Signalcraft picks caller numbers automatically; the old number pages lead to the voice overview.
          { path: '/apps/:appId/voice/numbers', element: <Navigate to=".." relative="path" replace /> },
          { path: '/apps/:appId/voice/callers', element: <Navigate to=".." relative="path" replace /> },
          { path: '/apps/:appId/voice/agents', element: <AppScoped><VoiceAgentsPage /></AppScoped> },
          { path: '/apps/:appId/voice/agents/:agentId', element: <AppScoped><VoiceAgentEditorPage /></AppScoped> },
          { path: '/apps/:appId/voice/registration', element: <AppScoped><SmsRegistrationPage channel="voice" /></AppScoped> },
          { path: '/apps/:appId/forms', element: <AppScoped><FormsPage /></AppScoped> },
          { path: '/apps/:appId/forms/:formId', element: <AppScoped><FormDetailPage /></AppScoped> },
          { path: '/apps/:appId/chat', element: <AppScoped><ChatAnalyticsPage /></AppScoped> },
          { path: '/apps/:appId/chat/inbox', element: <AppScoped><ChatInboxPage /></AppScoped> },
          { path: '/apps/:appId/chat/bots', element: <AppScoped><ChatBotsPage /></AppScoped> },
          { path: '/apps/:appId/chat/bots/:botId', element: <AppScoped><ChatBotEditorPage /></AppScoped> },
          { path: '/apps/:appId/automation', element: <AppScoped><AutomationPage /></AppScoped> },
          { path: '/apps/:appId/analytics', element: <AppScoped><AnalyticsPage /></AppScoped> },
          { path: '/apps/:appId/billing', element: <AppBillingRedirect /> },
          { path: '/apps/:appId/automation/new', element: <AppScoped><NewWorkflowFromLinkPage /></AppScoped> },
          { path: '/apps/:appId/automation/:workflowId', element: <AppScoped><WorkflowBuilderPage /></AppScoped> },
          { path: '/apps/:appId/ai', element: <Navigate to="agents" replace /> },
          { path: '/apps/:appId/ai/agents', element: <AppScoped><AgentsPage /></AppScoped> },
          { path: '/apps/:appId/ai/agents/:agentId', element: <AppScoped><AgentDetailPage /></AppScoped> },
          { path: '/apps/:appId/ai/approvals', element: <AppScoped><ApprovalsPage /></AppScoped> },
          { path: '/apps/:appId/ai/integrations', element: <AppScoped><IntegrationsPage /></AppScoped> },
          { path: '/apps/:appId/crm', element: <Navigate to="deals" replace /> },
          {
            element: <CrmCrumbs />,
            children: [
              { path: '/apps/:appId/crm/deals', element: <AppScoped><DealsPage /></AppScoped> },
              { path: '/apps/:appId/crm/deals/:dealId', element: <AppScoped><DealDetailPage /></AppScoped> },
              { path: '/apps/:appId/crm/leads', element: <AppScoped><LeadsPage /></AppScoped> },
              { path: '/apps/:appId/crm/companies', element: <AppScoped><CompaniesPage /></AppScoped> },
              { path: '/apps/:appId/crm/companies/:companyId', element: <AppScoped><CompanyDetailPage /></AppScoped> },
              { path: '/apps/:appId/crm/tasks', element: <AppScoped><TasksPage /></AppScoped> },
              { path: '/apps/:appId/crm/reports', element: <AppScoped><ReportsPage /></AppScoped> },
              { path: '/apps/:appId/crm/settings', element: <AppScoped><CrmSettingsPage /></AppScoped> },
            ],
          },
          { path: '/orgs/:orgId/applications', element: <ApplicationsPage /> },
          { path: '/orgs/:orgId/team', element: <TeamPage /> },
          { path: '/orgs/:orgId/settings', element: <OrgSettingsPage /> },
          { path: '/orgs/:orgId/audit-log', element: <AuditLogPage /> },
          { path: '/orgs/:orgId/billing', element: <BillingPage /> },
          { path: '/account', element: <AccountPage /> },
          { path: '/admin', element: <AdminGuard /> },
        ] }],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]

// The outer Suspense covers pages outside the app layout (sign-in, onboarding, public pages). A chunk that
// fails to load throws to RouteError like any other route error.
export const router = createBrowserRouter([{ errorElement: <RouteError />, element: <SuspenseOutlet />, children: routes }])
