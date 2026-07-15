# Parallel Maintainer Relief and Linux Feature Marketplace Factory

- Status: Proposed for Gary and Josh to review
- Date: 2026-07-15
- Decision owners: Gary for `codex-desktop-linux`; the organization owners for
  the Marketplace
- Appetite: A multi-cycle program with two bounded first-cycle proofs developed
  in parallel, not a complete feature migration or autonomous software factory

## Decision

Run two deliberately separate tracks:

1. **Maintainer relief in `ilysenko/codex-desktop-linux`.** Produce a read-only,
   all-public-feature current-DMG catalog and a concise owner decision packet.
   It prepares evidence for Gary's usefulness and carrying-cost decision. It
   grants no new issue, label, readiness, assignment, review, or merge
   authority.
2. **A Linux feature Marketplace in `Open-Source-AI-Labs`.** Build a public,
   source-led feature factory with independently versioned packages,
   per-feature ownership, a generated catalog and front end, synthetic CI,
   source provenance, signed multi-architecture artifacts for original Linux
   helpers, controlled promotion, and agent-ready work only after a human
   accepts the feature and its maintenance cost.

The tracks meet through a narrow compatibility-attestation contract. The
Marketplace never receives authority over the official DMG, the extracted
application, core acceptance, native package promotion, the updater, rollback,
or privileged installation.

The current GitHub-hosted DMG workflow remains unchanged while its artifact and
cache policy is reviewed separately. New Marketplace compatibility work uses a
local or maintainer-controlled worker and returns only an allowlisted
attestation. This design does not pretend that GitHub-hosted and self-hosted DMG
workers are equivalent.

## Source conversation and repository boundary

The source thread is [issue #752](https://github.com/ilysenko/codex-desktop-linux/issues/752),
not a pull request. The relevant decisions are in its comments:

- Josh proposed separating the gateway from an independently maintained Linux
  feature Marketplace in
  [this comment](https://github.com/ilysenko/codex-desktop-linux/issues/752#issuecomment-4961448511).
- Gary said unreviewed contributions cost more time than implementing from a
  good issue in
  [this comment](https://github.com/ilysenko/codex-desktop-linux/issues/752#issuecomment-4968575383).
- Gary supported moving optional features out, while identifying native helpers,
  the updater, and `sudo` as a code-injection boundary in
  [this comment](https://github.com/ilysenko/codex-desktop-linux/issues/752#issuecomment-4970353775).
- Gary summarized the carrying-cost problem in
  [this comment](https://github.com/ilysenko/codex-desktop-linux/issues/752#issuecomment-4970399328):
  most users do not use the optional extensions, but those extensions create a
  disproportionate share of maintenance.

The Discord conversation closes three false premises:

- organization ownership is not the missing recognition or collaboration
  mechanism;
- GitHub Actions cost is not a current problem;
- another generic automated PR reviewer does not replace the owner's judgment
  about usefulness and permanent maintenance.

Gary explicitly invited parallel Marketplace work in
`Open-Source-AI-Labs`, including a front end. As observed on 2026-07-15, the
organization is an empty shell: zero repositories and teams, with Gary and Josh
as its two active administrators. It is a clean future boundary, not yet a
factory or governance system.

`ilysenko/codex-desktop-linux` remains authoritative for the application gateway
and its existing governance. The core repository is not transferred, and
Marketplace contributors do not receive organization-owner, core-repository,
DMG-worker, signing, or privileged-release authority merely by maintaining a
feature.

## The actual problems

### Maintainer decision load

The expensive question arrives too late. By the time a substantial PR exists,
Gary may need to reconstruct the user problem, determine whether the behavior
belongs in the project, inspect the implementation, estimate its future drift
and support burden, and decide whether a tiny audience justifies that burden.

PR review automation can detect code defects. It cannot make the product
decision that Gary described.

### Current-DMG coverage gap

The repository already has strong core CI, shared current-DMG acceptance,
structured patch reports, DMG Intelligence, a durable local watchdog, Nix
refresh automation, package checks, and governed labels. The missing seam is a
complete current-DMG view of every public optional feature.

There are currently 27 tracked public feature manifests. Twenty-five use patch
descriptors, ten use legacy stage hooks, two use cleanup hooks, and none uses
package hooks. Scheduled acceptance uses the committed empty feature
configuration. Synthetic tests cover tracked feature tests, but scheduled CI
does not prove every feature's exact profile against the current DMG. Passing
core acceptance therefore does not prove the public feature catalog is healthy.

### Ownership concentration

Optional feature code, its upstream drift, its review, and its lifecycle are
currently concentrated in the core repository. A Marketplace only reduces
Gary's burden if feature authors own the entire feature lifecycle. Moving files
without moving responsibility would produce a second repository for Gary to
maintain.

### Trust boundary

The current feature model can stage code and resources into an application
that is later packaged or installed through privileged paths. A remote package
must never be able to turn catalog membership into arbitrary install-time code
execution, DMG access, or `sudo` authority.

## Desired outcomes

- Gary can decide continue, retire, externalize, defer, or decline without
  opening raw workflow logs or reconstructing a local investigation.
- Every public optional feature has an explicit owner, trust level, capability
  declaration, evidence record, disable path, and retirement path.
- A human-approved issue is sufficiently shaped for a contributor or coding
  agent to implement without rediscovering the problem.
- Feature owners, not Gary, carry ordinary implementation review and current
  compatibility responsibility for their packages.
- Public source validation and catalog promotion are regular, cheap, and
  reproducible; contributor-defined execution remains confined to the
  post-review isolated lane.
- Exact-DMG and installed-runtime evidence stays inside the core or
  maintainer-controlled boundary.
- No cloud workflow publishes a DMG-derived application, modified ASAR, Linux
  app package, proprietary asset, or unverified binary blob. Protected
  Marketplace workflows may publish signed x86_64/aarch64 artifacts built only
  from original open-source Linux helper source.

## Non-goals

This design does not include:

- changing ownership or governance of `codex-desktop-linux`;
- granting organization ownership to every source author;
- automatically deciding that a feature is useful or remains worth carrying;
- generic AI PR review, automatic coding-agent assignment, or automatic merge;
- migrating all 27 current features during the first cycle;
- running Marketplace pull requests on DMGs or extracted application content;
- publishing rebuilt Codex apps, `.deb`, RPM, pacman, AppImage, Nix, ASAR, or
  DMG-derived artifacts; original signed Linux helper binaries are a distinct,
  allowed Marketplace output;
- privileged Marketplace hooks, package-manager scripts, or host mutation;
- one repository per feature before independent repositories are justified;
- copying Bluefin's Hive, Beads, stale lifecycle labels, or broken `/claim`
  implementation;
- treating a successful source test as proof that a feature works in the
  proprietary application;
- resolving the legal status of existing core caches or Cachix output by
  assertion.

## System boundary

```text
Open-Source-AI-Labs/codex-linux-marketplace
  source packages + signed original helpers + schemas + fixtures + front end
                         |
                         | immutable source digest and gateway contract
                         v
ilysenko/codex-desktop-linux
  trusted loader + local composition + shared acceptance + updater/promotion
                         |
                         | selected package source, current official DMG
                         v
local or maintainer-controlled compatibility worker
  exact-profile build + patch report + selected DMG Intelligence annotation
                         |
                         | allowlisted compatibility attestation
                         v
Marketplace catalog and owner packet
  human continuation/admission decision -> ready issue -> native assignment
```

No arrow gives the Marketplace control of the DMG worker or the gateway's
promotion decision.

## Authority map

| Question | Authority |
| --- | --- |
| Does the default Linux application candidate pass? | Existing shared acceptance in `codex-desktop-linux` |
| Is Marketplace source structurally valid? | Marketplace schemas, policy scanner, source tests, and human reviews |
| Was one exact feature profile exercised against one exact DMG and target? | Compatibility attestation from the trusted local/self-hosted worker |
| Is a feature useful enough to admit or continue? | Human owner decision |
| May a package enter candidate or stable? | Its feature owner plus the required Marketplace/security/core reviewers |
| May a package affect a user's local app? | The gateway's trusted loader, permission policy, and exact enabled-profile acceptance |
| May a PR merge? | Human reviewers under the repository's rules |

DMG Intelligence is advisory. It can make a known contract easier to inspect,
but it cannot invent a Linux product obligation, fail shared acceptance by
itself, admit work, or promote a package.

## Answers to Gary's architecture questions

| Question | Recommended decision |
| --- | --- |
| Use the native Codex marketplace? | Yes for standard Codex plugins, skills, and MCP servers. Do not reimplement capabilities Codex can already discover and activate. |
| Need a Linux Extension Manager? | Yes, but it is a trusted gateway component in `codex-desktop-linux`, not arbitrary Marketplace code. It owns signed helper delivery, launcher/runtime integration, local rebuilds, transactional activation, and rollback. |
| What remains core? | Essential Linux compatibility, the generic feature API/loader, signature and capability enforcement, candidate build/promotion, updater/rollback, package-format adapters, and the smallest required platform glue. |
| Is the catalog preconfigured? | Ship the official Open Source AI Labs catalog identity as a discoverable default. Fetching/installing code and every capability expansion still requires explicit user consent. Third-party catalogs require an explicit connection and separate trust decision. |
| Is Computer Use first? | Use a trivial declarative canary first, then Computer Use as the first full-stack migration pilot. It is valuable precisely because it exercises the hard split, but it is too complex to be the factory's first proof of basic catalog mechanics. |
| Migrate all at once? | No. Inventory all features immediately, then migrate incrementally by immutable package version. Remove the old in-tree implementation only after install, disable, update, rollback, and current-DMG evidence pass for that feature. |

### Two activation engines, one catalog

The catalog is unified for discovery, ownership, compatibility, and permissions,
but lifecycle authority is not. Every installable package declares exactly one
`activationAuthority`: `codex_native` or `linux_extension_manager`.

Mixed-authority packages are forbidden in v1. A catalog entry may present a
feature family and link separately versioned dependent packages, but each
manager installs, activates, updates, and rolls back only the state it owns.
Until native Codex exposes a transaction API, the UI must not promise atomic
installation or rollback across both authorities.

Activation routes by authority and declared class:

| Activation class | Components | User-visible effect |
| --- | --- | --- |
| `task` | `codex_native` skills, MCP servers, and standard plugins | Available to a new task; no app rebuild |
| `restart` | Linux Extension Manager user services, launcher/runtime extensions, and components loaded at app start | App or managed service restart |
| `rebuild_restart` | Linux Extension Manager ASAR transforms, Electron main-process patches, minified webview patches, and staged app resources | Build a sibling candidate, validate it, promote transactionally, then restart |

Every package and front-end entry declares its authority and activation class
before install or update. Within one Linux Extension Manager package, the
strongest component class wins. The UI must never imply hot loading when a
restart or rebuild is required.

### Native helper delivery

Users must not need Rust, a compiler toolchain, or a privileged package hook to
install an extension. For original Linux native helpers, the protected
Marketplace release lane may build x86_64 and aarch64 artifacts from the exact
reviewed source and publish:

- immutable versioned binaries;
- SHA-256 checksums;
- source commit and reproducible-build identity;
- SBOM and license metadata;
- OIDC-backed provenance/signature;
- supported libc/runtime and architecture metadata.

Only the post-review isolated lane may compile temporary helpers for PR tests,
and it publishes nothing. Only protected release jobs may publish helper
artifacts. The gateway verifies the version, digest, provenance, target,
declared capabilities, and user scope before staging. Helper artifacts may
never contain or be linked with extracted OpenAI content.

### Trust-root lifecycle

OIDC provenance proves which protected workflow produced an artifact; it is not
by itself the runtime trust policy. Before any stable helper activation, the
gateway and Marketplace must accept a versioned verifier policy that defines:

- the pinned root identities and threshold needed to authorize catalog targets;
- permitted repository, workflow, ref/tag, environment, issuer, and subject
  claims for helper provenance;
- signed target metadata binding package version, source/helper digests,
  architecture, capability class, activation authority, and expiry;
- monotonic snapshot/version rules that reject freeze and rollback attacks;
- root and release-key rotation, overlap windows, expiry, and emergency
  revocation;
- a signed deny/revocation channel and compromise-recovery procedure;
- offline behavior: cached unexpired metadata may keep an installed version
  working, but stale metadata cannot authorize a new install or upgrade;
- clock-skew handling and an auditable response to signer equivocation.

The root is pinned by trusted gateway source, not downloaded on first use from
the catalog it is meant to authenticate. Compromise freezes new promotion,
retains the prior safe pointer, revokes the affected identity, and requires a
threshold-authorized root rotation. Stable is blocked until this contract is
implemented and independently reviewed.

Public catalog, helper, and compatibility statements bind repository, workflow
identity, commit, digest, schema version, and expiry under an allowlisted
workload identity. Personal keys cannot sign them; revocation statements use
the same threshold-governed root.

### Package-format support in the first release

| Format | `task` / `restart` | `rebuild_restart` | First-release policy |
| --- | --- | --- | --- |
| User-local installation | Supported through user-scoped extension state | Supported through the existing sibling-candidate acceptance path | Primary reference path |
| `.deb`, RPM, pacman native installs | Supported without Marketplace-owned package hooks | Supported through the core updater/rebuild and existing privileged promotion boundary | Supported after format-specific rollback proof |
| AppImage | External user-state components may be supported | Runtime self-patching is not supported safely | Rebuild-required packages are unavailable in v1 |
| Nix/NixOS | Supported only as pinned declarative inputs | Built composition must remain declarative and reproducible | No imperative Marketplace install or mutation |

The Marketplace does not use package-manager maintainer scripts. Any privileged
promotion remains an existing gateway operation over a previously accepted
candidate.

### Computer Use split

"Computer Use" currently names more than one ownership surface. The pilot must
name exact paths and package IDs rather than treating it as one movable feature:

1. **Retained core behavior:** `computer-use-linux/`, the generic feature API,
   default platform registration, permission enforcement, and trusted
   lifecycle/rollback remain in `codex-desktop-linux` for this pilot. Extracting
   that backend is a separate paired core design decision, not an implication of
   Marketplace membership.
2. **First Linux Extension Manager candidate:**
   `linux-features/x11-ewmh-computer-use/` is inventoried as its own optional
   package. It does not replace the core Computer Use backend.
3. **Native Codex package:** any standard plugin, skill, or MCP surface that can
   use native Codex discovery becomes a separate `codex_native` package with its
   own lifecycle.
4. **Optional local transform package:** UI exposure and ASAR/webview patches
   become a separate `linux_extension_manager` / `rebuild_restart` package,
   applied only by the gateway.

The catalog may group these packages as the Computer Use feature family, but it
cannot install or roll them back as one atomic package in v1.

The migration cannot preserve aliases, duplicate staging, or fallback payloads
indefinitely. After the new package is proven for the current DMG and supported
formats, remove the obsolete in-tree payload and old-DMG paths in the same
feature migration.

Core remains authoritative for an individual feature until its cutover is
approved. Each cutover records the old and new owner, package version, catalog
digest, disable path, rollback, and removal commit. Bulk moves, dual active
implementations, and ambiguous ownership are prohibited.

## Track A: maintainer decision packet

### One product surface

The first core-repository bet produces one concise, read-only packet with two
sections:

1. **Current-DMG public-feature catalog** — what exact profile and target were
   exercised for every tracked public feature, what passed or failed, and what
   remains unproven.
2. **Owner admission or continuation records** — bounded decision prompts for
   new proposals and features that failed, drifted repeatedly, lack ownership,
   or expand their trust surface.

It does not create, reopen, close, comment on, or label GitHub issues. It does
not redefine `status: ready for work`, impose a repository-wide issue-before-PR
rule, or add contribution-attribution policy. Existing upstream core-drift issue
reconciliation remains unchanged as a pre-existing governed producer.

### Authoritative feature inventory

The catalog enumerates every tracked immediate feature directory under
`linux-features/`, excluding `linux-features/local/`. Every valid
`feature.json` appears. A malformed or missing required manifest appears as an
`inconclusive` entry; it is never silently dropped.

Repository presence means tracked, not permanently supported. Automation may
not infer that an optional feature should be repaired again.

### Exact canonical profiles

Version one uses one isolated profile per feature plus its loader-resolved
dependency closure. It does not attempt a set-cover optimizer or assume all
constraints are complete and declarative.

Each profile:

- starts from the empty public-feature configuration;
- enables one feature and its resolved dependencies;
- uses manifest/default settings only;
- records every non-default setting dimension as untested unless a checked-in
  profile already covers it;
- uses a private mutable app workspace with no mutable directory shared across
  profiles;
- may reuse only immutable, correctly keyed inputs;
- has bounded time, disk, log, and process limits;
- cannot prevent the remaining profiles from running if it hangs or fails.

The first catalog rehearsal executes patch descriptors and declarative resources
only. The ten legacy stage hooks and two cleanup hooks are arbitrary executable
surfaces; they are not run across proprietary input merely because they exist in
the repository. A feature that depends on one reports
`inconclusive_unsafe_to_execute` for that surface until the hook is converted or
an enforceable sandbox with egress, filesystem, process, and output controls is
approved. That is an explicit migration blocker, not a fabricated pass.

The result vocabulary is factual:

- `passed_for_exact_profile`;
- `failed_for_exact_profile`;
- `inconclusive` with a bounded reason code;
- `not_applicable_by_declared_rule` only when an existing target rule proves it.

The catalog never uses unqualified `compatible`. A pass proves only the
surfaces actually exercised for that profile and target.

### Evidence snapshot

Three identities remain distinct:

- **DMG campaign:** authoritative DMG SHA-256, preserving the existing watchdog
  contract.
- **Freshness hint:** ETag or Last-Modified plus Content-Length. HTTP metadata
  can trigger a check but cannot establish byte identity.
- **Evidence snapshot:** DMG SHA, subject source SHA, trusted executor-code SHA,
  event trust level, environment/toolchain identity, target, profile-definition
  hash, and evidence-schema version.

Source, schema, environment, or profile changes produce a new evidence snapshot
under the same DMG campaign. They do not create a new DMG campaign or duplicate
the current-DMG issue.

Evidence is input-addressed and machine-produced, not assumed deterministic.
Mutable external inputs and unresolved dependencies are recorded. Repeated runs
that disagree become `inconclusive`.

The canonical evidence payload contains stable comparison facts. A separate run
envelope contains timestamps and run URLs. Only the canonical payload is
content-addressed.

Each feature record includes:

- feature ID and manifest path;
- exact DMG SHA and wrapper source SHA;
- trusted executor SHA and event trust level;
- runner architecture, operating image identity, install/package mode, and
  relevant desktop/session assumptions;
- enabled feature, dependency closure, and canonical settings;
- patch, resource, staging, runtime, package, and test surfaces exercised;
- exact commands and bounded results;
- package, desktop, service, native-helper, or runtime behavior not exercised;
- explicit missing, stale, or redacted evidence.

### DMG Intelligence use

Full Intelligence output remains ephemeral and local/private. The packet may
include only allowlisted registry IDs and bounded statuses that map to an
already-known repository contract.

In the first cycle, Intelligence:

- annotates candidate-only protected-surface evidence;
- does not publish source samples, proprietary paths, strings, assets, bridge
  inventories, or full reports;
- does not use baseline-dependent `MOVED`, `REMOVED`, or `PAYLOAD_CHANGED`
  claims unless an approved durable baseline exists;
- does not turn `NEW_UPSTREAM_CAPABILITY` or `LINUX_SUBSTRATE_GAP` into work;
- does not determine a feature result without the owning contract's existing
  validation.

### Owner decision record

For a new proposal or optional-feature continuation, the packet records:

1. observed problem and evidence;
2. audience signal and explicit uncertainty;
3. proposed placement: core, optional Marketplace package, external project,
   or decline;
4. rejected lower-cost alternatives;
5. new permanent maintenance and trust obligations;
6. capability, privilege, network, persistence, packaging, and upstream-DMG
   surfaces involved;
7. disable, externalize, and retirement path;
8. owner decision: continue, retire, externalize, defer, or decline, with date.

If the decision is continue, a separate implementation contract supplies scope,
non-goals, owning paths, acceptance evidence, and required tests. Product
admission and implementation instructions are not conflated.

The default packet view is one overview table followed only by detail blocks
for failed, inconclusive, unowned, or decision-required features. Passing
features do not produce repetitive prose.

### Track A execution and publication boundary

- Reuse the existing watchdog/current-DMG trigger and DMG campaign identity; do
  not create another campaign service.
- Run the first all-feature rehearsal locally or on a maintainer-controlled
  worker from trusted source.
- Do not execute Marketplace pull-request code with the proprietary DMG.
- Do not upload the new packet, full Intelligence report, or new derived fields
  until Gary approves the exact allowlist and publication location.
- Existing GitHub-hosted DMG download, cache, extraction, and diagnostics remain
  unchanged pending a separate policy audit.
- Absence of reusable trusted evidence causes a rerun or an explicit stale
  result, never an assumed pass.

## Track B: Linux feature Marketplace factory

### Organization gate

Before accepting feature code, harden `Open-Source-AI-Labs`:

- require 2FA and document two-person break-glass recovery;
- keep base repository permission read-only;
- disable general member repository creation and private-repository forking;
- create least-privilege teams for Marketplace maintainers, feature authors,
  security reviewers, and release engineers;
- use protected branches and tags, required checks, CODEOWNERS, no force-push or
  deletion, and human review;
- require two reviews for workflow, schema, trust-policy, and security changes;
- default workflow tokens to read-only and pin Actions by full commit SHA;
- enable secret scanning, push protection, dependency alerts, private
  vulnerability reporting, and an SPDX license policy;
- use a protected promotion environment and OIDC provenance rather than
  long-lived signing keys;
- provision no cross-repository credential in v1. If a later approved workflow
  requires one, use a least-privilege GitHub App, never a personal access token.

The organization's Free plan has no custom repository roles. Teams and
repository permissions must therefore carry the least-privilege model.

### Repository topology

Start with one public monorepo,
`Open-Source-AI-Labs/codex-linux-marketplace`, plus a small organization `.github`
repository for shared public policy. Do not create a shared Actions repository
until a second real consumer exists.

The Marketplace monorepo owns:

```text
AGENTS.md
CONTRIBUTING.md
SECURITY.md
LICENSE
.github/CODEOWNERS
.github/ISSUE_TEMPLATE/
.github/labels.json
contracts/
schemas/
docs/label-governance.md
features/<id>/
catalog/
site/
tooling/
tests/fixtures/       # synthetic and original only
```

`.github/labels.json` is the label source of truth. Labels are
maintainer-managed; authors may recommend classifications but cannot
self-classify. `workflow: manual only` is a hard stop for every item-specific
automation path.

The canonical source lives under `features/<id>/`. Catalog JSON, client views,
and the static front end are deterministic generated views. CI fails when a
generated view differs from canonical source. The front end has no separate
database or private administrative truth.

A monorepo gives the first factory one schema, one dependency graph, one policy
scanner, one compatibility matrix, and one catalog while retaining
path-specific ownership. Heavy or independently governed packages may move to
their own repositories later without changing the catalog contract.

### Package contract

Every package declares:

| Field | Required contract |
| --- | --- |
| Identity | Schema version, stable ID, semver, title, and description |
| Legal | SPDX license, neighboring license/notice files, source origin |
| Ownership | Primary owner, backup owner, owning GitHub team, support channel |
| Support | Experimental, community, or verified; tracked does not mean permanently supported |
| Compatibility | Marketplace API, gateway feature API, architectures, runtimes, desktop/package constraints |
| Composition | Plugins, skills, MCPs, patch descriptors, resources, runtime hooks, and native-helper source/artifact references |
| Activation authority | Exactly one of `codex_native` or `linux_extension_manager`; cross-authority packages are invalid in v1 |
| Install route | Native Codex Marketplace link or Linux Extension Manager package identity |
| Activation | `task`, `restart`, or `rebuild_restart`; strongest component requirement wins only within one authority |
| Distribution | Versioned x86_64/aarch64 helper artifact identities, runtime requirements, and release policy; CI supplies the source digest |
| Format behavior | Explicit support or rejection for user-local, native packages, AppImage, and Nix |
| Graph | Validated dependencies and conflicts; no direct undeclared imports between features |
| Transform ownership | Public patch IDs, protected-surface/target IDs, ordering needs, and declared overlap policy |
| Capabilities | Complete filesystem, process, network, input, capture, persistence, native, and local-build surface |
| Lifecycle | Install, update, disable, uninstall, cleanup, rollback, migration, deprecation, retirement, and data-retention behavior |
| Tests | Deterministic source and synthetic commands plus exact behavior they prove |
| Supply chain | Explicit source-file allowlist, dependency locks/checksums, SBOM inputs |

Rules:

- Features are disabled by default.
- CI computes the source-tree digest outside the package tree, excluding
  generated catalog/site files, and records it in generated catalog and
  provenance metadata. A package manifest cannot contain its own digest.
- One ID maps to one owning directory and ownership record.
- Duplicate IDs, dependency cycles, unresolved conflicts, and undeclared patch
  target overlaps fail validation. A declared overlap requires an explicit
  ordering contract and combined-profile test; sharing a bundle file alone is
  not treated as proof of conflict.
- No path traversal, unsafe symlink, undeclared executable, arbitrary
  preinstall/postinstall script, or package hook is permitted. Only the trusted
  gateway may fetch a manifest-declared, signed helper artifact by immutable
  digest.
- Package hooks, builds, and activation operations cannot initiate network
  access. The trusted gateway may perform a separate user-consented acquisition
  step from declared HTTPS origins using immutable versions and locked hashes.
  Runtime network access must declare endpoints and purposes and requires
  separate user consent.
- Every capability expansion on upgrade requires renewed consent.
- The source package never carries proprietary application content, a compiled
  application, or an unverified binary blob. Original helper artifacts live in
  the protected release channel and are referenced by immutable digest.
- Marketplace source is applied only through a versioned, trusted gateway API.
- A package version cannot be reused for a different source or helper digest. A
  downgrade requires an explicit governed rollback record naming the prior
  pointer and reason.

The current manifests are migration inputs, not the new contract. In
particular, the ten legacy stage hooks must become declarative resources/runtime
hooks or an explicitly sandboxed adapter before migration.

### Trust model

Catalog trust and capability are independent axes. Provenance remains source and
build evidence, not a trust tier.

**Catalog trust tiers**

- `T0 local/unlisted`: user-controlled and outside catalog guarantees.
- `T1 community`: metadata and policy reviewed; experimental channel only.
- `T2 verified`: primary and backup owners, independent reviews, complete
  evidence, and stable-channel eligibility.
- `T3 core-integrated`: Marketplace approval plus explicit
  `codex-desktop-linux` maintainer approval for app-patching integration.

Stable C0/C1 requires T2 or higher. Stable C2 requires T3, core approval for
first stable admission, and unexpired exact-DMG evidence. T1 never leaves
experimental.

**Capability classes**

- `C0 declarative`: native Codex Marketplace skills/plugins, static resources,
  schemas, and literal settings or arguments.
- `C1 user execution`: native Codex Marketplace MCPs/services plus Extension
  Manager scripts, verified prebuilt user-space helpers, and user services with
  explicit consent and sandbox policy.
- `C2 local app transform`: Extension Manager patch descriptors applied only to
  a user's authorized local candidate by the trusted gateway. Network denial,
  path containment, and process limits are necessary but not sufficient; C2
  also requires core review and exact-DMG evidence. Remote C2 activation is
  disabled in cycle one.
- `denied in Marketplace v1`: root/package-manager hooks, `sudo`, `doas`,
  `pkexec`, setuid, file capabilities, system services, udev, polkit, `/etc`,
  `/usr`, `/var`, Docker sockets, arbitrary host mutation, undeclared
  persistence, or unbounded install execution.

A trusted author cannot make a high-risk capability low-risk. Capability risk
always wins.

### Feature ownership

- Experimental/candidate requires one accountable owner. Verified/stable
  requires a primary and backup owner. Gary is never inferred as the owner or
  backup for an unowned package.
- Feature owners handle routine post-admission triage, implementation review,
  compatibility decisions, documentation, and retirement for their package.
- Feature owners may recommend decisions but cannot approve their own admission,
  catalog-trust escalation, independent security review, or promotion.
- Marketplace-wide contracts, schemas, shared SDK code, workflows, and catalog
  policy require Marketplace-maintainer review.
- C1 packages require independent executable/security review.
- A C2 package's first stable admission, new gateway contract, new core
  touchpoint, or capability expansion requires a core app maintainer. Ordinary
  updates within an already-approved contract use package-owner and security
  review plus fresh exact-DMG evidence; they do not recreate Gary as the routine
  review queue.
- A new core touchpoint requires a paired design decision in
  `codex-desktop-linux`; core exposes the smallest generic extension point and
  feature-specific behavior remains in the package.
- A declared owner-health policy may place a package into
  `status: needs maintainer decision`; a human Marketplace maintainer decides
  whether to demote or quarantine it. An ownerless feature cannot enter stable,
  and automation never transfers its burden silently.
- Shared feature code lives in an explicitly owned SDK package; cross-feature
  private imports are rejected.

This distributes maintenance without distributing broad administrative
control.

### Bluefin pattern, corrected for this project

The transferable pattern is:

```text
structured proposal
  -> human admission and trust-tier decision
  -> status: ready for work
  -> native GitHub assignment
  -> contributor or coding-agent implementation
  -> source-led CI and evidence packet
  -> feature-owner/security/catalog review
  -> candidate catalog
  -> exact-source local compatibility attestation
  -> human stable promotion
  -> rollback and durable feature learning
```

Humans decide what is admitted, what trust it receives, and what is promoted.
Agents can implement accepted work and prepare evidence. The ready queue uses a
single governed status; native assignment is the claim. Version one has no
`/claim`, agent dispatcher, auto-implementation, or auto-merge.

Issue forms distinguish:

- new feature admission;
- current compatibility failure;
- security report;
- factory/contract change;
- documentation or support correction.

An agent-ready issue contains the accepted problem, audience evidence and
uncertainty, owner, placement, trust/capability class, scope, non-goals,
affected paths, acceptance commands, exact evidence identity, and retirement
condition.

### Marketplace workflow factory

**Every untrusted pull request** runs repository-owned declarative validators on
GitHub-hosted runners with a read-only token, no secrets, no self-hosted runner,
no Docker socket, no privileged container, and no `pull_request_target`
execution of contributor code. It performs:

- schema, semantic, catalog, and generated-view validation;
- changed-package and reverse-dependent selection;
- duplicate-ID, ownership, dependency-cycle, conflict, and compatibility
  checks;
- forbidden-file, binary-blob, symlink, path-containment, executable-inventory,
  and capability-policy checks;
- secret, license, dependency-metadata, and source-SBOM scans;
- plugin, skill, and MCP manifest validation;
- capability-diff reporting;
- deterministic catalog and site rebuild checks.

Untrusted PR jobs do not run package-defined build, test, hook, install, or
activation commands. They have no OIDC permission, secrets, write token,
persistent cache write, release environment access, or cross-repository
credential.

**Post-review isolated execution** is manually admitted only after the changed
source, capability diff, dependencies, and commands have human review. A
disposable worker with enforced egress denial, no repository credential, no
DMG, a temporary home, bounded processes/time/disk/output, and no persistent
cache or host mounts runs unit/synthetic tests, fake-gateway
install/update/disable/uninstall/rollback tests, and temporary helper
compilation under bounded CPU, disk, and wall time. Temporary binaries and
assembled trees are destroyed and never uploaded.

**Protected main** runs the complete package matrix, clean-room dependency
installation, current and previous gateway-contract testkits, two-build source
tree reproducibility, catalog integrity, and source provenance. Package-defined
commands use the same isolated execution policy; protected-main credentials are
not present in that worker.

**Protected native-helper release** is a separate immutable-tag-triggered job
with narrowly scoped `contents: write`, `id-token: write`, and
`attestations: write`. It cross-builds or natively builds declared x86_64 and
aarch64 helpers from the exact reviewed source, natively tests them, verifies
the target and reproducibility policy, and publishes only the helper,
checksums, SBOM, license material, signature, and provenance. It never downloads
a DMG or assembles a Codex application/package. Promotion requires the
protected release environment and the C1/T2 review gate.

**Nightly, only when the gateway contract SHA changes**, the factory opens or
updates a reviewed compatibility-bump pull request and runs every package
against the source-only gateway testkit.

The write-capable contract detector never executes package code. It only opens
or updates the bot PR; declarative checks run in the ordinary read-only PR job
and package-defined tests run only in the post-review isolated lane.
The detector is a separate protected-default-branch workflow with only
`contents: write` and `pull-requests: write`; it never checks out a contributor
head or shares its token with a job that does.

**Weekly** it runs dependency, vulnerability, secret, and license scans. Owner,
trust-tier, quarantine, rollback, and candidate-state checks are event-driven by
the relevant metadata or promotion change; version one adds no generic weekly
AI triage or cleanup bot.

No Marketplace cadence downloads a DMG or tests against proprietary
application content.

### Catalog and front end

The public front end is a generated view of the signed catalog. Each feature
page shows:

- owner and backup;
- catalog trust tier and capability class;
- native Codex Marketplace install route or Linux Extension Manager route;
- activation class and whether a new task, restart, or rebuild is required;
- current channel and immutable source digest;
- license, source, dependencies, conflicts, and supported targets;
- permissions, network, persistence, and native-code disclosures;
- signed helper architectures, versions, checksums, and provenance when present;
- AppImage and Nix limitations plus supported native-package formats;
- exact source/synthetic checks passed;
- latest allowlisted local compatibility attestation and what it did not prove;
- install, disable, uninstall, rollback, and reporting paths.

The site never says `compatible` without an exact attestation scope. Missing or
expired current-DMG evidence is displayed as unverified, not silently green.

### Promotion and rollback

Channels are catalog pointers to immutable source and its verified original
helper artifacts, never rebuilt app artifacts:

```text
experimental -> candidate -> stable
```

- Merge may place an immutable feature tree SHA in experimental.
- Candidate promotion pins the same SHA after source, synthetic, isolated
  execution, and capability checks.
- Stable promotion moves the same SHA only after tier-specific human approval
  and required local evidence.
- The exact source and helper digests tested are the exact digests promoted.
- Stable retains the immediately previous pointer for rollback.
- Failed local activation or acceptance leaves the working app and installed
  feature set unchanged.
- C2 failure does not block the default gateway release; the incompatible
  optional package remains pinned, hidden for that target, or marked unverified.

`task`, `restart`, and `rebuild_restart` are versioned activation-contract
identifiers mapped only by their owning authority; packages cannot supply
commands or shell. An install remains `installed_pending_activation` until the
required new-task or restart handshake succeeds. `restart` atomically promotes
Linux-manager state before restarting. `rebuild_restart` journals and validates
the complete app candidate and matching Linux-manager lock before promotion.

### Gateway handoff

`codex-desktop-linux` publishes a source-only compatibility kit containing:

- feature-manifest schema;
- feature API and capability vocabulary;
- resource, hook, lifecycle, and containment interfaces;
- synthetic gateway/app fixtures;
- installer safety rules;
- contract version and migration notes.

The Marketplace tests packages against the kit. A pass means source-valid and
gateway-contract-compatible, not current-DMG-compatible.

The local gateway resolves a package only when:

- its declared feature API range includes the installed gateway;
- its source-tree digest matches the catalog and provenance statement;
- its capability class is permitted;
- every required helper matches its immutable version, target, checksum, and
  provenance;
- the user has consented to the declared capabilities;
- exact enabled-profile acceptance is satisfied before promotion.

There are no package-owned privileged install scripts. The trusted gateway owns
all composition, containment, promotion, and rollback mechanics.

The gateway records only Linux Extension Manager-owned state in a
content-addressed lock: catalog digest, Linux package versions, source/helper
digests, activation classes, capability grants, settings, gateway
source/version, and exact DMG identity. A `rebuild_restart` candidate is
accepted and promoted as one transaction with that lock. Rollback restores the
previous app and its matching Linux extension lock; it never combines an older
app with the failed candidate's extension state. Native Codex components roll
back through Codex's own lifecycle unless Codex later exposes a real transaction
API.

If the user postpones a new-task handoff, restart, or rebuild activation, the
manager records `installed_pending_activation` and never reports the package
active before the required handshake completes.

On AppImage, the manager reports `rebuild_restart` packages as unsupported and
does not mutate the mounted image, an extracted runtime, cached app resources,
wrappers, or user-cache copies. On Nix, the UI is informational; activation
occurs only through pinned flake/module configuration, the manager never mutates
the Nix store, and rollback is Nix generation rollback.

### Current-DMG compatibility attestation

For Marketplace C2 and other DMG-coupled packages, the local or
maintainer-controlled worker evaluates the immutable package source in one exact
profile. The allowlisted attestation contains:

- package ID, version, source-tree digest, and catalog commit;
- activation class plus any helper version, architecture, and digest;
- gateway source SHA and feature API version;
- upstream DMG SHA-256 and app version;
- target/environment identity, package format, and canonical settings;
- patch-report verdict and public descriptor IDs;
- bounded tests run and results;
- explicit untested behavior and redacted warnings;
- canonical evidence digest, worker policy/schema version, and reviewer
  identity; a signer identity is added only after its policy is approved.

It excludes DMG bytes, ASARs, extracted files, source samples, proprietary paths
or assets, screenshots from the app, generated app directories, native packages,
private features, account/runtime state, secrets, and unredacted logs.

A DMG-coupled package is verified only for the exact DMG SHA and target recorded
in its attestation. A new authoritative DMG SHA expires that current badge until
the same immutable package/helper digests pass again. A failing enabled package
rejects its candidate without replacing the working app; it does not make the
default feature-free gateway release or users without that package fail. It
blocks promotion for every installation that enabled it until the package is
disabled or repaired.

Cycle-one local evidence is private and reviewer-bound. It cannot receive a
public verified badge or stable promotion until Gary and the Marketplace owners
approve the signer identity, signing boundary, verification policy, and public
field allowlist. GitHub OIDC provenance for helper releases does not
authenticate a separate local DMG worker.

When that policy exists, the Marketplace verifies the compatibility signature
and identity. The gateway still makes its own local promotion decision; an
attestation is evidence, not authority.

### Issue generation after trust is earned

Generated package issues live only in the Marketplace repository under its own
checked-in label and automation policy. Track A remains read-only in the core
repository unless Gary later delegates a separately reviewed trusted core
producer.

The first two current-DMG campaigns run in shadow mode and generate one
consolidated owner packet. If feature owners find the packet accurate and useful,
a trusted Marketplace producer may later create or update one fingerprint-owned
issue per failed package with `status: needs maintainer decision`.

The producer may never infer continued support. The feature owner chooses:

- continue support;
- retire;
- externalize;
- defer;
- decline as not planned.

Only an explicit continue decision materializes or transitions a bounded issue
to `status: ready for work`. Native assignment remains the claim. Intelligence-
only findings and newly discovered upstream capabilities remain packet
annotations until a human admits them.

The write-capable producer must use trusted default-branch code, a configured
bot identity, managed body regions, stable package/DMG fingerprints, immediate
pre-write re-reads, and a hard stop for manual-only state. Human closure or a
not-planned decision is terminal unless a human reopens it.

## Public and private artifact policy

| Public Marketplace | Private/local or prohibited |
| --- | --- |
| Original Linux feature source, docs, schemas, synthetic fixtures | DMG bytes or caches |
| Catalog JSON and generated static site | Extracted app, ASAR, proprietary source samples or assets |
| Source-tree digests, source SBOMs, license metadata | Rebuilt Codex app or native Linux app packages |
| Signed x86_64/aarch64 artifacts built from original Linux helper source | DMG-derived, proprietary, undeclared, or unverified binary blobs |
| Gateway contract/testkit | User feature config and local/private features |
| Allowlisted signed compatibility attestations after owner approval | Runtime logs, settings, account/session/updater/rollback state |
| Temporary post-review isolated compilation with no upload | Compiled Codex application/package release assets |

Existing core-repository artifact and cache behavior is outside the Marketplace
boundary and requires a separate owner-approved audit. It is neither expanded
nor declared safe by this design.

## Cadence

| Event | Work |
| --- | --- |
| Marketplace PR | Changed packages and reverse dependents; source/synthetic/security gates |
| Marketplace main push | Complete package matrix, reproducibility, provenance, generated catalog/site |
| Immutable helper release | Protected x86_64/aarch64 build, checksum, SBOM, provenance, and human promotion |
| Gateway contract change | One reviewed Marketplace compatibility-bump PR; no DMG |
| New authoritative DMG SHA | One local/self-hosted exact-profile campaign for tracked packages |
| Weekly | Dependency, vulnerability, secret, and license scans |
| Stable promotion | Manual protected-environment approval of immutable source and helper digests |

HTTP polling may run frequently, but expensive current-DMG work runs only when
the authoritative DMG SHA or the complete evidence snapshot changes. Weak or
missing HTTP identity never proves evidence current.

A new DMG, executor policy, evidence schema, or global gateway contract reruns
all exact profiles. A package-source or scoped gateway change reruns only the
changed package, dependency closure, and declared patch-overlap groups.

## Failure handling

- **Malformed or missing feature manifest:** include an inconclusive catalog
  entry; do not omit the feature.
- **Factory bug, timeout, missing runner dependency, or resource exhaustion:**
  fail the campaign. These cannot be counted as acceptable feature-level
  inconclusive results.
- **Unsupported external target:** report inconclusive with the exact missing
  capability unless a declared rule proves not-applicable.
- **One profile hangs:** cancel that isolated profile and continue the remaining
  matrix within bounded resources.
- **Campaign crash or global disk exhaustion:** persist per-profile checkpoints,
  clean only fingerprint-owned orphan workspaces, and resume without mixing
  partial outputs. A campaign is complete only when its expected inventory is
  accounted for.
- **New DMG appears mid-campaign:** cancel or supersede the old run atomically;
  never publish a packet containing mixed DMG identities.
- **Repeated-run disagreement:** mark evidence inconclusive and prevent
  promotion.
- **Stale gateway, DMG, package, or PR head:** invalidate the attestation or
  scope packet; never present it as current.
- **Self-hosted worker unavailable:** produce no new current-DMG assertion. The
  existing stable pointer and core app remain untouched.
- **Capability expansion:** block update until policy review and renewed user
  consent.
- **Missing architecture, checksum, provenance, or runtime match:** reject the
  helper before staging; never fall back to local compilation or a mutable
  download.
- **Unsupported activation class for the installed format:** show the package as
  unavailable with the exact reason. Do not attempt AppImage self-patching or
  imperative Nix mutation.
- **Owner disappears:** demote or quarantine the package; do not transfer its
  burden silently to Gary.
- **Package fails against a new DMG:** keep the default app release independent;
  pin, hide, retire, or mark the optional package unverified.
- **App/extension transaction fails:** preserve the working app and its current
  extension lock; rollback restores the last matching pair.
- **Crash between app exchange and lock commit:** use the existing durable
  promotion journal to recover one complete matching app/lock pair.
- **Cross-authority partial success:** mixed-authority packages and one-click
  atomic bundles are forbidden in v1, so native Codex success cannot be reported
  as a successful Linux transform transaction.
- **Restart or new-task handoff postponed:** retain
  `installed_pending_activation`; do not report active until the handshake.
- **Revoked or malicious package:** remove it from resolvable catalog pointers,
  preserve an auditable tombstone, and give the gateway a signed deny decision
  without deleting user data silently.
- **Emergency deny:** require two distinct Marketplace/security maintainers and
  a signed audit record containing reason, scope, expiry, and review date. It
  may block future resolution, activation, or update, but never silently
  uninstall software or delete user data.
- **Attestation output violates the allowlist:** publish nothing and fail the
  job.
- **Covert proprietary-data output:** allow only normalized enums, public IDs,
  fixed-size digests, and bounded repository-owned reason messages. Reject
  package-controlled filenames, warning prose, samples, timing-derived fields,
  or arbitrary strings from public attestations.
- **Helper toolchain, dependency, architecture, or reproducibility failure:**
  publish nothing, retain the prior catalog pointer, and never compile locally
  or use a mutable fallback.
- **Catalog or signer compromise, freeze/rollback attack, equivocation, clock
  skew, or offline revocation:** apply the trust-root freeze, expiry, revocation,
  and threshold-rotation policy; do not authorize a new install from stale or
  disputed metadata.
- **No safe redaction or worker isolation:** stop the public compatibility lane;
  do not weaken the boundary to complete the demo.
- **Historical data missing:** state that history is best-effort. Absence of a
  recorded drift event does not mean zero prior drift.

## First parallel cycle

### Track A deliverables

1. A sanitized evidence fixture derived from the #948 / draft #997
   broad-profile case. Check it in only after Gary approves the exact field
   allowlist; otherwise retain it privately for the rehearsal.
2. One local current-DMG catalog covering all 27 tracked public feature
   manifests with exact claims and unknowns.
3. One owner packet that asks continue, retire, externalize, defer, or decline.
4. A negative fixture based on a deliberately rejected or externalized proposal,
   proving that the right output is sometimes no implementation.
5. Gary's review of the packet before any optional-feature issue writer or
   public derived-data publication is enabled.

### Track B deliverables

1. Organization hardening and documented authority boundaries.
2. The public Marketplace monorepo with policy, package/attestation schemas,
   deterministic catalog JSON and generated catalog view, a read-only PR
   factory, and a synthetic gateway testkit. A bespoke front-end application is
   outside the first cycle; the generated view proves the product contract.
3. A migration inventory for all 27 current feature manifests: intended owner,
   catalog trust tier, capability class, legacy-hook debt, placement, and migration
   decision.
4. An internal declarative schema canary, then Computer Use as the sole feature
   migration pilot, split into core platform glue, native Codex components,
   signed user-space helpers, and optional `rebuild_restart` UI transforms.
5. Protected x86_64/aarch64 helper release proof where the pilot needs native
   code: immutable binaries, checksums, SBOM, provenance, signature,
   wrong-architecture rejection, no local compilation fallback, and no DMG in
   the release job.
6. A local exact-profile compatibility attestation for the immutable pilot
   source/helper digests and a generated catalog view that states precisely
   what it proves and which activation class each component requires. Keep that
   view private until Gary approves the public field allowlist.
7. Synthetic activation and joint app/extension rollback contracts plus a
   private candidate rehearsal. Remote C2 activation and stable remain disabled
   until ownership, signer policy, provenance verification, and local rollback
   are proven.

DMG Intelligence may be offered as a direct local developer tool that operates
only on a user-supplied file, but its Marketplace packaging must obey the same
capability and evidence rules. It is not the Marketplace's acceptance engine.

The first cycle does not deliver unsigned, undeclared, or unbounded remote-code
installation, privileged helpers, all-feature migration, automatic issue
creation, automatic agent dispatch, or a rebuilt application release.

## Success criteria

The design succeeds when:

1. Every tracked public feature appears in both the migration inventory and the
   current-DMG catalog; none disappears because it lacks a patch descriptor or
   has a malformed manifest.
2. Factory-caused inconclusive results are zero for the accepted rehearsal.
3. Every catalog result identifies the exact DMG, source, target, settings,
   surfaces exercised, and untested behavior.
4. Gary can make the continuation/placement decision without opening raw logs,
   and can identify what remains unproven from the default packet view.
5. The core shared acceptance decision and existing issue reconciliation remain
   unchanged.
6. The Marketplace accepts no DMG, extracted app, proprietary fixture, rebuilt
   app/package, unverified binary blob, privileged hook, or unbounded install
   script; original helper artifacts pass the protected multi-architecture
   release policy.
7. A clean clone can regenerate the catalog view, recompute the pilot source
   digest, and verify the signatures, attestations, checksums, and SBOMs of its
   published original helper binaries.
8. The candidate pilot has one accountable owner, declared capabilities and
   activation authority/class, complete install/disable/uninstall/rollback
   behavior, and the required reviews; a backup is mandatory before stable.
9. A gateway contract change tests every package source without claiming
   current-DMG compatibility.
10. An optional-package failure cannot block or replace a working default app,
    and rollback restores the matching prior extension lock.
11. After a human continuation decision, the packet contains enough reviewed
    fields to draft an implementation-ready issue without another investigation;
    cycle one does not generate or mutate issues.
12. The Marketplace reduces Gary's feature-review surface rather than creating a
    second queue that only he can clear.

## Options considered

### 1. Core-repository agentification only

Improves evidence and issue quality but leaves optional-feature ownership and
trust concentrated in Gary's repository. Useful as Track A, insufficient alone.

### 2. Marketplace only

Creates the right long-term ownership boundary but does not immediately reduce
the current repo's decision reconstruction or prove all current features against
new DMGs. Useful as Track B, insufficient alone.

### 3. Parallel packet plus source-led factory — selected

Provides immediate owner-decision relief while building the durable feature
ownership platform. The attestation contract keeps the tracks coupled only where
evidence must cross.

### 4. Fully autonomous issue-to-agent-to-merge factory

Rejected. It automates the creation and administration of more work before
proving that the work is useful, safe, owned, or worth maintaining.

## Circuit breakers

- If the owner packet does not reduce Gary's reconstruction work, do not enable
  issue generation.
- If the organization is not hardened, do not open feature intake.
- If a feature cannot name a primary and backup owner, it cannot enter stable.
- If migration requires arbitrary privileged package scripts, keep the behavior
  in core or redesign the gateway API.
- If the public factory cannot test a contract without proprietary fixtures,
  keep that test local and do not fabricate a public pass.
- If exact-source attestation and rollback are not proven, stop at candidate.
- If the next DMG produces noisy, duplicated, or unowned work, keep the campaign
  read-only and fix the evidence model before adding automation.

## Smallest validation before implementation planning

Render two artifacts by hand from existing evidence:

1. the all-feature owner packet for issue #948 / draft PR #997, plus one
   proposal whose correct decision is decline or externalize;
2. the Computer Use split-pilot packet showing native Codex versus Extension
   Manager routes, activation classes, signed helper evidence, format limits,
   current-DMG scope, and joint rollback state.

Ask Gary two separate questions:

1. Can you decide continue, retire, externalize, defer, or decline from this
   packet without reconstructing the investigation?
2. Can you see exactly what the source-led factory and local attestation did
   not prove?

Only after both answers are yes should this design become an implementation
plan.
