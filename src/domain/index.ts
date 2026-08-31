/**
 * Ferret's canonical knowledge model.
 *
 * Provider-neutral by construction: nothing in this directory imports a
 * provider, a driver or a parser, and nothing names GitHub, Jira or Git. A
 * *pull request* is a canonical concept that several systems map onto, and the
 * mapping belongs to the provider.
 *
 * The boundary test enforces that this stays true, because the moment the
 * canonical model knows about a specific source, replacing that source becomes
 * a redesign rather than a provider swap.
 */

export {
  ENTITY_KINDS,
  EntityKind,
  LIFECYCLE_STATES,
  LifecycleState,
  entityKindSchema,
  isEntityKind,
  isLifecycleState,
  lifecycleStateSchema,
} from './kinds.js';

export {
  ENTITY_ATTRIBUTE_SCHEMAS,
  agentAttributes,
  branchAttributes,
  commitAttributes,
  deploymentAttributes,
  developerAttributes,
  documentAttributes,
  evidenceAttributes,
  fileAttributes,
  fileVersionAttributes,
  issueAttributes,
  pullRequestAttributes,
  releaseAttributes,
  repositoryAttributes,
  reviewAttributes,
  sessionAttributes,
  worktreeAttributes,
  type EntityAttributes,
} from './attributes.js';

export {
  UUID_PATTERN,
  canonicalId,
  canonicalKey,
  contentHash,
  encodeKeyParts,
  identify,
  isCanonicalId,
  stableStringify,
  type CanonicalKeyInput,
} from './identity.js';

export {
  ENTITY_SCHEMA_VERSION,
  assertCanonicalEntity,
  createEntity,
  entityInputSchema,
  entityKindDefinition,
  entitySourceSchema,
  externalIdSchema,
  isUnchanged,
  registerEntityKind,
  registeredEntityKinds,
  resetEntityKindRegistry,
  type CanonicalEntity,
  type EntityInput,
  type EntityKindDefinition,
  type EntitySource,
  type ExternalId,
} from './entity.js';

export {
  OPEN_INTERVAL,
  RELATIONSHIP_TYPE_PATTERN,
  RELATIONSHIP_TYPES,
  RelationshipType,
  createRelationship,
  isOpen,
  isValidAt,
  registerRelationshipType,
  registeredRelationshipTypes,
  relationshipInputSchema,
  relationshipKey,
  relationshipTypeDefinition,
  resetRelationshipTypeRegistry,
  type CanonicalRelationship,
  type RegisterRelationshipTypeOptions,
  type RelationshipTypeDefinition,
  type RelationshipTypeDefinition,
} from './relationship.js';

export {
  Completeness,
  EVIDENCE_METHODS,
  EVIDENCE_STATES,
  EvidenceMethod,
  EvidenceState,
  createEvidence,
  detectConflicts,
  evidenceInputSchema,
  evidenceKey,
  evidenceLocatorSchema,
  integrityHashOf,
  isDirectObservation,
  preferredEvidence,
  redactStatement,
  type CanonicalEvidence,
  type ConflictGroup,
  type EvidenceInput,
  type EvidenceLocator,
} from './evidence.js';

export {
  ACTOR_CLASSES,
  ActorClass,
  actorClassForKind,
  assertSameActorClass,
  createIdentityAlias,
  entityKindForActor,
  identityAliasInputSchema,
  isActorClass,
  aliasKey,
  type IdentityAlias,
  type IdentityAliasInput,
  type IdentityCollision,
} from './actor.js';

export {
  GLOBAL_SCOPE,
  SCOPE_KINDS,
  ScopeDecision,
  ScopeKind,
  constrains,
  evaluateScope,
  isInScope,
  mergeSelectors,
  scopeContextSchema,
  scopeSchema,
  scopeSelectorSchema,
  type Scope,
  type ScopeContext,
  type ScopeEvaluation,
  type ScopeSelector,
} from './scope.js';

export {
  Compatibility,
  SURFACE_POLICIES,
  VersionedSurface,
  assertSafeToWrite,
  checkCompatibility,
  databaseSchemaPolicy,
  isArtifactStale,
  summarizeCompatibility,
  type CompatibilityReport,
  type CompatibilityVerdict,
  type SurfacePolicy,
} from './compatibility.js';

export {
  SessionStatus,
  continueSession,
  createSession,
  endSession,
  sessionInputSchema,
  sessionKey,
  touchSession,
  type Session,
  type SessionInput,
} from './session.js';

export {
  SessionCaptureKind,
  createSessionCapture,
  sessionCaptureInputSchema,
  sessionCaptureKey,
  type SessionCapture,
  type SessionCaptureInput,
} from './session-capture.js';

export {
  createSessionCheckpoint,
  advanceSessionCheckpoint,
  sessionCheckpointKey,
  sessionCheckpointInputSchema,
  type JsonValue,
  type SessionCheckpoint,
  type SessionCheckpointInput,
} from './session-checkpoint.js';
