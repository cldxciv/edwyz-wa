/**
 * Route-equivalent guards for action definitions (docs/EDDY-SPEC.md 4.4). Every definition calls these actor-aware
 * functions, never the bare service functions that skip the route's checks. Re-exports only: the source modules are not
 * edited here.
 *
 * Inbox: visibility, the act-on rule, status changes with their transition rules, bulk updates, the team pool, the 24-hour
 * window, and the route-shared assignment and tag operations. Contacts: visibility, phone masking, the scope filters and
 * the actor-aware update.
 */
export {
  assertConversationVisible,
  assertContactVisible,
  contactScopeWhere,
  inboxScopeWhere,
  maskContact,
  maskPhone,
  shouldMaskFor,
  viewerRules,
  type ViewerRules,
} from "@/lib/teams/visibility";
export { assertCanActOnConversation, assertCanSetStatus, bulkUpdate, canActOn, setStatus, MAX_BULK_IDS, type BulkInput, type BulkResult } from "@/lib/inbox/status";
export { assertInTeamPool, teamPoolUserIds } from "@/lib/teams/pool";
export { isWithinServiceWindow } from "@/lib/inbox/window";
export { createContact, updateContact } from "@/lib/contacts/service";
export { assignAsActor, setTagsAsActor, type AssignResult, type AssignTarget, type TagChange, type TagsResult } from "@/lib/inbox/actor-ops";
export { hasRole, requireRole } from "@/lib/tenancy";
