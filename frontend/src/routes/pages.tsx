/**
 * Route pages, loaded on demand: each module becomes its own chunk, so the first load (sign-in, the app
 * shell) stays small and heavy libraries (charts, the flow builder, the email editor) load only with the
 * pages that use them. A failed chunk load throws to the route's error boundary (RouteError).
 */
import { lazy, Suspense, type ComponentType } from 'react'
import { Outlet } from 'react-router-dom'
import { FullPageSpinner } from '@/components/page'

/** lazy() for a named export. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the same bound React.lazy itself uses
type AnyComponent = ComponentType<any>

function named<M, K extends keyof M>(load: () => Promise<M>, key: K) {
  return lazy(async () => ({ default: (await load())[key] as Extract<M[K], AnyComponent> }))
}

/** Child routes inside a Suspense boundary: the parent (e.g. the app shell) stays while a page's chunk loads. */
export function SuspenseOutlet() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Outlet />
    </Suspense>
  )
}

const auth = () => import('@/modules/auth/PasswordPages')
const verify = () => import('@/modules/auth/VerifyPages')
const emailPages = () => import('@/modules/email/EmailPages')
const emailPublic = () => import('@/modules/email/PublicPages')
const kit = () => import('@/modules/email/campaignKit')
const collections = () => import('@/modules/audience/CollectionsPages')
const voice = () => import('@/modules/voice/VoicePages')
const agents = () => import('@/modules/voice/AgentsPages')
const sms = () => import('@/modules/sms/SmsPages')
const companies = () => import('@/modules/crm/CompaniesPages')
const bots = () => import('@/modules/chat/BotsPages')
const onboarding = () => import('@/modules/organizations/OnboardingPages')
const automation = () => import('@/modules/automation/AutomationPages')

// The app shell and the sign-in form are lazy too: the login page never downloads the shell (menus, command
// palette), and signed-in pages never download the form libraries.
export const AppLayout = named(() => import('@/layouts/AppLayout'), 'AppLayout')
export const LoginPage = named(() => import('@/modules/auth/LoginPage'), 'LoginPage')
// The public marketing site: its own chunks (layout + one per page), never the app shell or chart libraries.
export const MarketingLayout = named(() => import('@/modules/marketing/MarketingLayout'), 'MarketingLayout')
export const HomePage = named(() => import('@/modules/marketing/HomePage'), 'HomePage')
export const ProductPage = named(() => import('@/modules/marketing/ProductPage'), 'ProductPage')
export const PricingPage = named(() => import('@/modules/marketing/PricingPage'), 'PricingPage')
export const RegisterPage =named(() => import('@/modules/auth/RegisterPage'), 'RegisterPage')
export const ForgotPasswordPage = named(auth, 'ForgotPasswordPage')
export const ResetPasswordPage = named(auth, 'ResetPasswordPage')
export const VerifyEmailPage = named(verify, 'VerifyEmailPage')
export const VerifyEmailSentPage = named(verify, 'VerifyEmailSentPage')
export const AcceptInvitePage = named(() => import('@/modules/auth/AcceptInvitePage'), 'AcceptInvitePage')
export const AccountPage = named(() => import('@/modules/account/AccountPage'), 'AccountPage')
export const AppSettingsPage = named(() => import('@/modules/applications/AppSettingsPage'), 'AppSettingsPage')
export const ApplicationsPage = named(() => import('@/modules/applications/ApplicationsPage'), 'ApplicationsPage')
export const DashboardPage = named(() => import('@/modules/dashboard/DashboardPage'), 'DashboardPage')
export const CampaignEditorPage = named(() => import('@/modules/email/CampaignEditorPage'), 'CampaignEditorPage')
export const NewCampaignRoute = named(kit, 'NewCampaignRoute')
export const CampaignReportPage = named(() => import('@/modules/email/CampaignReportPage'), 'CampaignReportPage')
export const CampaignsPage = named(emailPages, 'CampaignsPage')
export const EmailOverviewPage = named(emailPages, 'EmailOverviewPage')
export const SendersPage = named(emailPages, 'SendersPage')
export const TemplateEditorPage = named(emailPages, 'TemplateEditorPage')
export const TemplatesPage = named(emailPages, 'TemplatesPage')
export const UnsubscribePage = named(emailPublic, 'UnsubscribePage')
export const VerifySenderPage = named(emailPublic, 'VerifySenderPage')
export const AudienceOverviewPage = named(() => import('@/modules/audience/AudienceOverviewPage'), 'AudienceOverviewPage')
export const ContactProfilePage = named(() => import('@/modules/audience/ContactProfilePage'), 'ContactProfilePage')
export const ContactsPage = named(() => import('@/modules/audience/ContactsPage'), 'ContactsPage')
export const ImportPage = named(() => import('@/modules/audience/ImportPage'), 'ImportPage')
export const SegmentBuilderPage = named(() => import('@/modules/audience/SegmentBuilderPage'), 'SegmentBuilderPage')
export const FieldsPage = named(collections, 'FieldsPage')
export const ListDetailPage = named(collections, 'ListDetailPage')
export const ListsPage = named(collections, 'ListsPage')
export const SegmentContactsPage = named(collections, 'SegmentContactsPage')
export const SegmentsPage = named(collections, 'SegmentsPage')
export const SuppressionPage = named(collections, 'SuppressionPage')
export const TagsPage = named(collections, 'TagsPage')
export const DevMailboxPage = named(() => import('@/modules/dev/DevMailboxPage'), 'DevMailboxPage')
export const DevSmsOutboxPage = named(() => import('@/modules/dev/DevSmsOutboxPage'), 'DevSmsOutboxPage')
export const DevCallLogPage = named(() => import('@/modules/dev/DevCallLogPage'), 'DevCallLogPage')
export const AutomationPage = named(automation, 'AutomationPage')
export const NewWorkflowFromLinkPage = named(automation, 'NewWorkflowFromLinkPage')
export const AnalyticsPage = named(() => import('@/modules/analytics/AnalyticsPage'), 'AnalyticsPage')
export const BillingPage = named(() => import('@/modules/billing/BillingPage'), 'BillingPage')
export const WorkflowBuilderPage = named(() => import('@/modules/automation/WorkflowBuilderPage'), 'WorkflowBuilderPage')
export const VoiceCampaignEditorPage = named(() => import('@/modules/voice/VoiceCampaignEditorPage'), 'VoiceCampaignEditorPage')
export const VoiceReportPage = named(() => import('@/modules/voice/VoiceReportPage'), 'VoiceReportPage')
export const VoiceAudioPage = named(voice, 'VoiceAudioPage')
export const VoiceCampaignsPage = named(voice, 'VoiceCampaignsPage')
export const VoiceOverviewPage = named(voice, 'VoiceOverviewPage')
export const VoiceAgentEditorPage = named(agents, 'VoiceAgentEditorPage')
export const VoiceAgentsPage = named(agents, 'VoiceAgentsPage')
export const SmsCampaignEditorPage = named(() => import('@/modules/sms/SmsCampaignEditorPage'), 'SmsCampaignEditorPage')
export const SmsReportPage = named(() => import('@/modules/sms/SmsReportPage'), 'SmsReportPage')
export const SmsComingSoonPage = named(() => import('@/modules/sms/SmsComingSoon'), 'SmsComingSoonPage')
export const SmsCampaignsPage = named(sms, 'SmsCampaignsPage')
export const SmsInboxPage = named(sms, 'SmsInboxPage')
export const SmsOverviewPage = named(sms, 'SmsOverviewPage')
export const SmsRegistrationPage = named(sms, 'SmsRegistrationPage')
export const SmsSendersPage = named(sms, 'SmsSendersPage')
export const SmsTemplatesPage = named(sms, 'SmsTemplatesPage')
export const DealsPage = named(() => import('@/modules/crm/DealsPage'), 'DealsPage')
export const DealDetailPage = named(() => import('@/modules/crm/DealDetailPage'), 'DealDetailPage')
export const CompaniesPage = named(companies, 'CompaniesPage')
export const CompanyDetailPage = named(companies, 'CompanyDetailPage')
export const LeadsPage = named(() => import('@/modules/crm/LeadsPage'), 'LeadsPage')
export const TasksPage = named(() => import('@/modules/crm/TasksPage'), 'TasksPage')
export const ReportsPage = named(() => import('@/modules/crm/ReportsPage'), 'ReportsPage')
export const CrmSettingsPage = named(() => import('@/modules/crm/SettingsPage'), 'CrmSettingsPage')
export const FormsPage = named(() => import('@/modules/forms/FormsPage'), 'FormsPage')
export const FormDetailPage = named(() => import('@/modules/forms/FormDetailPage'), 'FormDetailPage')
export const ChatAnalyticsPage = named(() => import('@/modules/chat/AnalyticsPage'), 'ChatAnalyticsPage')
export const ChatBotEditorPage = named(bots, 'ChatBotEditorPage')
export const ChatBotsPage = named(bots, 'ChatBotsPage')
export const ChatInboxPage = named(() => import('@/modules/chat/InboxPage'), 'ChatInboxPage')
export const AuditLogPage = named(() => import('@/modules/organizations/AuditLogPage'), 'AuditLogPage')
export const CreateApplicationPage = named(onboarding, 'CreateApplicationPage')
export const CreateOrganizationPage = named(onboarding, 'CreateOrganizationPage')
export const OrgSettingsPage = named(() => import('@/modules/organizations/OrgSettingsPage'), 'OrgSettingsPage')
export const TeamPage = named(() => import('@/modules/organizations/TeamPage'), 'TeamPage')
export const AdminPage = named(() => import('@/modules/admin/AdminPage'), 'AdminPage')
export const AgentsPage = named(() => import('@/modules/ai/AgentsPage'), 'AgentsPage')
export const AgentDetailPage = named(() => import('@/modules/ai/AgentDetailPage'), 'AgentDetailPage')
export const ApprovalsPage = named(() => import('@/modules/ai/ApprovalsPage'), 'ApprovalsPage')
export const IntegrationsPage = named(() => import('@/modules/ai/IntegrationsPage'), 'IntegrationsPage')
export const DevSlackLogPage = named(() => import('@/modules/dev/DevSlackLogPage'), 'DevSlackLogPage')
