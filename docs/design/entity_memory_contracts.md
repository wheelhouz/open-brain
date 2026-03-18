# Entity Memory Contracts

This document defines the v1 behavioral contracts for entity memory in Open Brain.

The goal is to support fluid, evidence-backed facts about entities without turning the system into a CRM. Facts are treated as memory claims, not fixed profile fields.

This document is the canonical reference for implementation behavior in v1.

---

## Purpose

Entity memory should let the system capture things like:

- where a person is from
- date of birth
- employer
- relationship to another entity
- changing or uncertain facts over time

The system must preserve:

- evidence
- uncertainty
- conflict
- temporal change

The system must avoid:

- rigid field-first data entry
- silently overwriting contradictory information
- presenting tentative facts as truth
- overbuilding ontology or visualization too early

---

## v1 Scope

### Build now

- `entities`
- `entity_mentions`
- `entity_facts`
- `entity_fact_evidence`
- fact extraction from thoughts
- evidence linking
- suggestion/review flow
- conflict handling on accept
- entity page with fact cards
- entity chat grounded in facts + evidence + recent mentions

### Do not build yet

- predicate registry
- stored briefs
- graph / constellation view
- automatic merge system
- complex ontology / schema for predicate typing

---

## Core Model

### Entities

An entity is a canonical node representing something the system tracks, such as:

- person
- organization
- place
- project
- concept
- artifact

### Facts

A fact is a memory claim attached to an entity.

Examples:

- Maya is from Porto
- Maya was born on May 12, 1991
- Maya works at Anthropic
- Maya used to live in Seattle

Facts are not fixed fields. They are flexible claims with status, review state, evidence, and optional temporal bounds.

### Evidence

Every fact should be traceable back to supporting evidence whenever possible.

Evidence usually comes from:

- a thought
- a conversation turn
- a manual note
- an inferred extraction result

---

## v1 Tables

## `entities`

Canonical entity record.

Suggested responsibilities:

- canonical name
- entity type
- aliases
- timestamps

## `entity_mentions`

Tracks extracted mentions of entities in thoughts and stores the outcome of entity resolution.

Suggested fields:

- `id`
- `thought_id`
- `raw_mention_text`
- `normalized_mention_text`
- `entity_id` (nullable until resolved)
- `resolution_state`
- `resolution_confidence`
- `resolution_metadata_json`
- timestamps

### Resolution state

Allowed v1 values:

- `auto_linked`
- `pending_review`
- `new_entity_created`
- `merged_after_review`
- `rejected`

### Notes

- `resolution_state` records how the mention was handled by the entity resolution contract.
- `resolution_metadata_json` may store supporting details such as matched alias, similarity scores, or reviewer action.
- Mentions should not rely on `entity_id` alone to imply how resolution happened.

## `entity_facts`

Stores memory claims about entities.

Suggested fields:

- `id`
- `entity_id`
- `predicate`
- `object_value_json`
- `object_display_text`
- `status`
- `review_state`
- `confidence`
- `source_kind`
- `valid_at_start`
- `valid_at_end`
- `embedding`
- timestamps

### Fact status

Allowed v1 statuses:

- `active`
- `tentative`
- `disputed`
- `superseded`

### Review state

Allowed v1 review states:

- `pending`
- `accepted`
- `rejected`

## `entity_fact_evidence`

Links facts to the evidence that supports them.

Suggested fields:

- `fact_id`
- `thought_id` or equivalent source id
- `excerpt`
- `evidence_type`
- timestamps

---

## Runtime Contract 1: Fact Insertion

This contract defines what happens when a new candidate fact is created from extraction, chat, or manual entry.

### Step 1: Normalize lightly

Before persistence:

- normalize predicate formatting
- normalize basic value formatting when possible
- preserve original human-readable display text

Examples:

- `Birthday` → `birthday` or chosen canonical formatting
- `"May 12th, 1991"` → structured date in `object_value_json`
- `"Porto, Portugal"` remains readable in display text

v1 uses light normalization only. It does not require a predicate registry.

### Step 2: Compare against existing facts on the same entity

Check for:

- duplicate or same-meaning facts
- conflicts with existing active facts
- conflicts only with superseded facts

### Step 3: Apply insertion behavior

#### If same meaning as an existing fact

Do not create a duplicate active fact.

Instead:

- attach new evidence to the existing fact
- optionally refresh timestamps or confidence

#### If no meaningful conflict exists

Insert the fact.

Default status depends on source:

- user-confirmed/manual: may be `active`
- extracted/agent-derived: usually `tentative`

#### If it conflicts with an active fact

Insert as `tentative` and flag for review.

Do not silently overwrite the active fact.

#### If it conflicts only with a superseded fact

Do not treat this as a live conflict.

Insert normally unless another active conflict exists.

### Step 4: Always attach evidence

If evidence exists, link it through `entity_fact_evidence`.

No fact extracted from content should exist without a source pointer unless it was entered manually.

---

## Runtime Contract 2: Entity Resolution

This contract defines what happens when a new entity mention is extracted from a thought or conversation.

v1 prioritizes deterministic behavior over cleverness.

### Resolution priority

#### 1. Exact normalized canonical name match

If the normalized mention exactly matches an entity canonical name:

- auto-link to that entity

#### 2. Exact normalized alias match

If the normalized mention exactly matches a known alias:

- auto-link to that entity

#### 3. Near-match / ambiguous match

If the mention is not an exact match but appears close to an existing entity based on fuzzy or embedding similarity:

- do not auto-link
- create a merge or review suggestion

Examples:

- Maya vs Maya Patel
- M. Patel vs Maya Patel

#### 4. No meaningful match

If no strong match exists:

- create a new entity

### v1 rule

Conservative by default.

If there is doubt, prefer:

- new entity
- or review suggestion

over incorrect silent attachment.

---

## Merge Contract

v1 supports explicit merge, not automatic merge.

### Merge UX

The user should see a side-by-side comparison including:

- canonical names
- aliases
- recent thoughts
- facts on both entities
- overlapping facts
- conflicting facts

The user chooses the canonical survivor.

### On merge

Move or unify:

- mentions
- facts
- evidence
- aliases

Keep merge history.

Do not delete the historical trace that a merge happened.

### Fact unification on merge

When two entities are merged, facts must be reconciled as well as moved.

#### If both entities have the same-meaning fact

Do not keep duplicate active facts.

Instead:

- keep one canonical fact
- merge supporting evidence onto that fact
- preserve the stronger status if they differ, using this rough precedence:
  - `active`
  - `tentative`
  - `disputed`
  - `superseded`

Example:

- Entity A: `from = Porto`
- Entity B: `from = Porto`

Result:

- one fact: `from = Porto`
- combined evidence from both prior facts

#### If facts are similar but not clearly identical

Do not silently collapse them.

Keep both and let normal conflict or review rules apply.

Example:

- `from = Porto`
- `from = Portugal`

These may be related but are not automatically the same fact.

---

## Runtime Contract 3: Chat Answer Behavior

This contract defines what entity-scoped chat is allowed to treat as truth.

Entity chat must be grounded in:

- entity identity
- high-salience facts
- supporting evidence
- recent raw thoughts mentioning the entity

### Grounding stack

1. entity identity and aliases
2. active / relevant facts
3. evidence for relevant facts
4. recent raw thoughts mentioning the entity
5. answer prompt with epistemic instructions

### Truthfulness rules

#### Active facts

May be stated directly.

Example:

- “Maya is from Porto.”

#### Tentative facts

Must be hedged.

Example:

- “Maya may have been born on May 12, 1991.”

#### Disputed facts

Must be framed as unresolved conflict.

Example:

- “Maya’s current city is unclear. One note supports Seattle, while a newer note suggests Portland.”

#### Superseded facts

Should be treated as past information, not current truth.

Example:

- “Maya previously lived in Seattle.”

#### Raw thoughts

Raw thoughts are supporting context, not canonical truth, unless no fact exists.

If no fact exists, the chat may say something like:

- “A recent thought suggests she may be considering a move back to Lisbon, but this has not been captured as a confirmed fact.”

### Chat must not

- present tentative facts as confirmed
- collapse disputed facts into one answer
- ignore temporal change
- infer certainty from a single unsupported mention

---

## Suggestion / Review Flow

The system should support “suggest, then absorb.”

Extracted facts should usually appear as suggestions first, not silently become active truth.

### Supported actions

- accept
- reject
- edit before accept

### Accept behavior

When the user accepts a suggestion:

#### If it does not conflict with an active fact

Accept normally.

#### If it conflicts with an active fact

Show conflict resolution UI before finalizing acceptance.

Example:

- New fact: Lives in Portland
- Existing active fact: Lives in Seattle

Prompt the user with actions such as:

- replace current with new
- keep both and mark uncertain
- mark older one as past
- cancel and edit

#### If it conflicts only with a superseded fact

Do not trigger live conflict flow unless another active conflict exists.

### Reject behavior

Rejected facts should remain stored with:

- `review_state = rejected`

They should not become active, should not appear as accepted memory, and should not be re-proposed as new suggestions from the same evidence unless the underlying extraction or source content materially changes.

This preserves auditability and reduces repeated suggestion noise.

---

## Conflict Handling Rules

Conflicts are first-class. They are not errors.

### Principles

- do not silently overwrite
- do not hide contradictions
- preserve history where temporal change is plausible
- distinguish current conflict from past/superseded information

### Examples

#### Plausible temporal change

- “Lives in Seattle” then later “Lives in Portland”

Possible resolution:

- mark Seattle as superseded / past
- mark Portland as active

#### True unresolved conflict

- two incompatible birth dates for the same person

Possible resolution:

- keep both as disputed
- require user review

---

## Predicate Strategy

v1 uses freeform predicates with light normalization.

This is intentional.

The system should learn from real usage before introducing a formal predicate registry.

### Implications

- predicates are stored as strings
- some predicates may later become canonicalized
- code should be written so predicate metadata can be added later without redesigning the whole model

Examples of predicates likely to matter later:

- `born_on`
- `from`
- `lives_in`
- `works_at`
- `met_through`

v1 does not require a central predicate table.

---

## Embeddings

v1 should embed both:

- thoughts
- facts

### Why

Thought embeddings are useful for:

- broad retrieval
- nuance
- evidence discovery

Fact embeddings are useful for:

- semantic recall of structured claims
- entity chat
- precise memory retrieval

### Fact embedding text

Facts should be embedded using a simple canonical text rendering of the claim.

Suggested format:

`<entity canonical name> — <predicate> — <object display text>`

Examples:

- `Maya Patel — from — Porto`
- `Maya Patel — born_on — May 12, 1991`
- `Maya Patel — works_at — Anthropic`
- `Maya Patel — lived_in — Seattle`

If temporal or status context materially affects meaning, it may be appended in the rendered text.

Examples:

- `Maya Patel — lived_in — Seattle — past`
- `Maya Patel — current_city — Portland — tentative`

The canonical rendering should be deterministic so retrieval behavior is stable.

---

## UX Principles

Entity memory should feel like a living memory board, not a profile form.

### Entity page should prioritize

- key fact cards
- recent supporting thoughts
- pending suggestions
- visible uncertainty/conflict

### Fact cards should support click-through

Clicking a fact should reveal:

- evidence
- last updated / supporting date
- edit action
- mark outdated
- mark wrong
- conflict details if applicable

### Conflict should be visible

Example card:

**Current city unclear**

- Seattle — supported by 2 older notes
- Portland — supported by 1 newer note

Actions:

- mark Seattle as past
- accept Portland as current
- keep both as disputed

---

## Non-Goals for v1

The following are explicitly out of scope:

- profile completeness systems
- CRM-style required fields
- ontology-heavy schema design
- auto-merging entities without review
- long-lived stored summaries / briefs
- graph exploration as a primary UX

---

## Decision Log

### 1. Single fact table with lifecycle fields

Decision:

- Use one `entity_facts` table with status and review-state fields.

Rationale:

- Keeps v1 simple while still supporting tentative, disputed, superseded, and rejected states.

### 2. Freeform predicates with light normalization

Decision:

- Store predicates as strings in v1, with light normalization only.

Rationale:

- Avoids premature ontology design while leaving room for later canonicalization.

### 3. Embed both thoughts and facts

Decision:

- Generate embeddings for both raw thoughts and fact claims.

Rationale:

- Thoughts support evidence retrieval and nuance; facts support direct memory recall.

### 4. Hybrid grounding for entity chat

Decision:

- Ground entity chat in facts, evidence, and recent mentions.

Rationale:

- Produces useful answers while preserving uncertainty, conflict, and temporal change.

---

## Guiding Principle

Facts are memory claims with evidence, not profile fields.

The system should help users accumulate, review, and reason about what seems true, what changed, and what remains uncertain.