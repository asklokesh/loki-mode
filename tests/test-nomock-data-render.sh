#!/usr/bin/env bash
# Regression coverage for static content catalogs versus mock operational data.

set -u

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/.." && pwd)"
VERIFY_MODULE="$REPO_ROOT/autonomy/verify.sh"
COUNCIL_MODULE="$REPO_ROOT/autonomy/completion-council.sh"
PASS=0
FAIL=0
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-nomock-render-XXXXXX")"
trap 'rm -rf "$WORK_ROOT"' EXIT

ok() { PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

log_info() { :; }
log_warn() { :; }
log_error() { :; }
log_success() { :; }
log_header() { :; }
log_step() { :; }
record_trust_event_bash() { :; }

# shellcheck disable=SC1090
source "$VERIFY_MODULE"
# shellcheck disable=SC1090
source "$COUNCIL_MODULE" 2>/dev/null || true

type verify_gate_nomock >/dev/null 2>&1 || {
    echo "FATAL: verify_gate_nomock unavailable"
    exit 2
}
type council_evidence_gate >/dev/null 2>&1 || {
    echo "FATAL: council_evidence_gate unavailable"
    exit 2
}

emit_static_features() {
    cat <<'TSX'
const features = [
  { title: 'Private', description: 'Encrypted locally', icon: 'lock' },
  { title: 'Fast', description: 'Ready in seconds', icon: 'bolt' },
];
export function Features() {
  return <div className="feature-grid">{features.map((feature) => <article className="feature-card" key={feature.title}>{feature.title}</article>)}</div>;
}
TSX
}

emit_static_pricing() {
    cat <<'TSX'
const plans = [
  { name: 'Starter', price: 'Free', features: ['Local notes', 'Export'] },
  { name: 'Pro', price: '$19', features: ['Unlimited notes'] },
];
export function Pricing() {
  return <div className="pricing-grid">{plans.map((plan) => <article className="pricing-card" key={plan.name}><h2>{plan.name}</h2><ul>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul></article>)}</div>;
}
TSX
}

emit_form_placeholder() {
    cat <<'TSX'
const features = [{ title: 'Private' }];
export function Page() {
  return <main><div className="feature-grid">{features.map((feature) => <article className="feature-card" key={feature.title}>{feature.title}</article>)}</div><input placeholder="Work email" /></main>;
}
TSX
}

emit_faker_users() {
    cat <<'TSX'
const users = Array.from({ length: 3 }, () => ({ name: faker.person.fullName() }));
export function Users() {
  return <table><tbody>{users.map((user) => <tr key={user.name}><td>{user.name}</td></tr>)}</tbody></table>;
}
TSX
}

emit_named_placeholder_users() {
    cat <<'TSX'
const users = ['John Doe', 'Jane Doe'];
export function Users() {
  return <ul className="user-list">{users.map((user) => <li key={user}>{user}</li>)}</ul>;
}
TSX
}

emit_inline_orders() {
    cat <<'TSX'
const orders = [{ id: 'ord-1042', customer: 'Acme', status: 'Paid', total: 149 }];
export function Orders() {
  return <table><tbody>{orders.map((order) => <tr key={order.id}><td>{order.customer}</td></tr>)}</tbody></table>;
}
TSX
}

emit_inline_users_grid() {
    cat <<'TSX'
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin', status: 'Active' }];
export function Users() {
  return <DataGrid rows={users.map((user) => user)} />;
}
TSX
}

emit_dashboard_metrics() {
    cat <<'TSX'
const metrics = [{ label: 'Monthly revenue', value: '$84,200', change: '+12%' }];
export function Dashboard() {
  return <div className="dashboard-grid">{metrics.map((metric) => <article className="metric-card" key={metric.label}>{metric.value}</article>)}</div>;
}
TSX
}

emit_unmapped_operational_array() {
    cat <<'TSX'
const users = [{ id: 'usr-1', role: 'Admin' }];
const features = [{ title: 'Private' }];
export function Features() {
  return <div className="feature-grid">{features.map((feature) => <article className="feature-card" key={feature.title}>{feature.title}</article>)}</div>;
}
TSX
}

emit_operational_with_real_source() {
    cat <<'TSX'
const users = [{ id: 'fallback', role: 'Admin' }];
export async function Users() {
  const response = await fetch('/api/users');
  const remoteUsers = await response.json();
  return <div className="user-grid">{users.map((user) => <article className="user-card" key={user.id}>{user.role}</article>)}{remoteUsers.length}</div>;
}
TSX
}

emit_fetched_users_rendered() {
    cat <<'TSX'
export async function Users() {
  const response = await fetch('/api/users');
  const users = await response.json();
  return <div className="user-grid">{users.map((user) => <article className="user-card" key={user.id}>{user.role}</article>)}</div>;
}
TSX
}

emit_unmapped_mock_users() {
    cat <<'TSX'
const mockUsers = [{ id: 'usr-1', role: 'Admin' }];
const features = [{ title: 'Private' }];
export function Features() {
  return <div className="feature-grid">{features.map((feature) => <article className="feature-card" key={feature.title}>{feature.title}</article>)}</div>;
}
TSX
}

emit_faker_docs_static_catalog() {
    cat <<'TSX'
const fakerDocumentation = 'Generate names with faker.person.fullName() in tests.';
const features = [{ title: 'Private' }, { title: 'Fast' }];
export function Features() {
  return <section aria-description={fakerDocumentation}>{features.map((feature) => <article key={feature.title}>{feature.title}</article>)}</section>;
}
TSX
}

emit_unused_placeholder_users() {
    cat <<'TSX'
const placeholderUsers = [{ id: 'usr-1', name: 'John Doe' }];
const benefits = [{ title: 'Private by design' }];
export function Benefits() {
  return <section>{benefits.map((benefit) => <article key={benefit.title}>{benefit.title}</article>)}</section>;
}
TSX
}

emit_todo_fetch_mock_orders() {
    cat <<'TSX'
// TODO: fetch orders from the backend.
const orders = [{ id: 'ord-1', customer: 'Acme', status: 'Paid', total: 149 }];
export function Orders() {
  return <table><tbody>{orders.map((order) => <tr key={order.id}><td>{order.customer}</td></tr>)}</tbody></table>;
}
TSX
}

emit_url_params_mock_orders() {
    cat <<'TSX'
const selectedTab = new URLSearchParams(location.search).get('tab');
const orders = [{ id: 'ord-1', customer: 'Acme', status: 'Paid', total: 149 }];
export function Orders() {
  return <section data-tab={selectedTab}>{orders.map((order) => <article key={order.id}>{order.customer}</article>)}</section>;
}
TSX
}

emit_unrelated_fetch_mock_users() {
    cat <<'TSX'
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
const configPromise = fetch('/api/config');
export function Users() {
  return <section data-config={String(configPromise)}>{users.map((user) => <article key={user.id}>{user.email}</article>)}</section>;
}
TSX
}

emit_static_comparison_table() {
    cat <<'TSX'
const comparisons = [
  { feature: 'Local encryption', starter: 'Included', pro: 'Included' },
  { feature: 'Export formats', starter: 'Two', pro: 'Unlimited' },
];
export function Comparison() {
  return <table><tbody>{comparisons.map((item) => <tr key={item.feature}><th>{item.feature}</th><td>{item.starter}</td><td>{item.pro}</td></tr>)}</tbody></table>;
}
TSX
}

emit_static_pricing_table() {
    cat <<'TSX'
const pricing = [
  { plan: 'Starter', price: '$0', support: 'Community' },
  { plan: 'Pro', price: '$19', support: 'Priority' },
];
export function PricingTable() {
  return <table><tbody>{pricing.map((tier) => <tr key={tier.plan}><th>{tier.plan}</th><td>{tier.price}</td><td>{tier.support}</td></tr>)}</tbody></table>;
}
TSX
}

emit_static_customer_stories() {
    cat <<'TSX'
const customerStories = [
  { company: 'Northstar', quote: 'We reclaimed five hours each week.' },
  { company: 'Acme', quote: 'The team leaves every meeting aligned.' },
];
export function Stories() {
  return <section>{customerStories.map((story) => <blockquote key={story.company}>{story.quote}</blockquote>)}</section>;
}
TSX
}

emit_datagrid_direct_users() {
    cat <<'TSX'
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin', status: 'Active' }];
export function Users() {
  return <DataGrid rows={users} />;
}
TSX
}

emit_table_datasource_users() {
    cat <<'TSX'
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin', status: 'Active' }];
export function Users() {
  return <Table dataSource={users} />;
}
TSX
}

emit_vue_users() {
    cat <<'VUE'
<script setup>
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
</script>
<template>
  <ul><li v-for="user in users" :key="user.id">{{ user.email }}</li></ul>
</template>
VUE
}

emit_svelte_users() {
    cat <<'SVELTE'
<script>
  const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
</script>
<ul>
  {#each users as user}<li>{user.email}</li>{/each}
</ul>
SVELTE
}

emit_direct_inline_users() {
    cat <<'TSX'
export function Users() {
  return <ul>{[{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }].map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_cross_file_mock_users() {
    mkdir -p "$CASE_REPO/src"
    cat >"$CASE_REPO/src/data.ts" <<'TS'
export const mockUsers = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
TS
    cat <<'TSX'
import { mockUsers as users } from './data';
export function Users() {
  return <ul>{users.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_filtered_mock_users() {
    cat <<'TSX'
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin', active: true }];
export function Users() {
  return <ul>{users.filter((user) => user.active).map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_default_import_mock_users() {
    mkdir -p "$CASE_REPO/src"
    cat >"$CASE_REPO/src/data.ts" <<'TS'
export default [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
TS
    cat <<'TSX'
import users from './data';
export function Users() {
  return <ul>{users.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_sample_features() {
    cat <<'TSX'
const sampleFeatures = [{ title: 'Private' }, { title: 'Fast' }];
export function Features() {
  return <section>{sampleFeatures.map((feature) => <article key={feature.title}>{feature.title}</article>)}</section>;
}
TSX
}

emit_dual_extension_users() {
    mkdir -p "$CASE_REPO/src"
    cat >"$CASE_REPO/src/data.ts" <<'TS'
export const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
TS
    cat >"$CASE_REPO/src/data.tsx" <<'TSX'
export const users = loadRemoteUsers();
TSX
    cat <<'TSX'
import { users } from './data';
export function Users() {
  return <ul>{users.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_large_source_tree_mock_orders() {
    mkdir -p "$CASE_REPO/src/generated"
    local index=0
    while [ "$index" -lt 5001 ]; do
        printf 'export const value%s = %s;\n' "$index" "$index" \
            >"$CASE_REPO/src/generated/value-$index.tsx"
        index=$((index + 1))
    done
    cat <<'TSX'
const orders = [{ id: 'ord-1', customer: 'Acme', status: 'Paid', total: 149 }];
export function Orders() {
  return <table><tbody>{orders.map((order) => <tr key={order.id}><td>{order.customer}</td></tr>)}</tbody></table>;
}
TSX
}

emit_optional_mock_users() {
    cat <<'TSX'
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
export function Users() {
  return <ul>{users?.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_derived_alias_mock_users() {
    cat <<'TSX'
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin', active: true }];
const visibleUsers = users.filter((user) => user.active);
export function Users() {
  return <ul>{visibleUsers.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_transformed_datagrid_users() {
    cat <<'TSX'
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
export function Users() {
  return <DataGrid rows={users.filter(Boolean)} />;
}
TSX
}

emit_react_state_users() {
    cat <<'TSX'
import { useState } from 'react';
export function Users() {
  const [users] = useState([{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }]);
  return <ul>{users.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_vue_ref_users() {
    cat <<'VUE'
<script setup>
import { ref } from 'vue';
const users = ref([{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }]);
</script>
<template>
  <ul><li v-for="user in users" :key="user.id">{{ user.email }}</li></ul>
</template>
VUE
}

emit_svelte_state_users() {
    cat <<'SVELTE'
<script>
  const users = $state([{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }]);
</script>
<ul>
  {#each users as user}<li>{user.email}</li>{/each}
</ul>
SVELTE
}

emit_generated_tasks() {
    cat <<'TSX'
const tasks = Array.from({ length: 3 }, (_, id) => ({ id, title: `Task ${id}`, status: 'Open' }));
export function Tasks() {
  return <ul>{tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>;
}
TSX
}

emit_barrel_mock_users() {
    mkdir -p "$CASE_REPO/src/data"
    cat >"$CASE_REPO/src/data/users.ts" <<'TS'
export const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
TS
    cat >"$CASE_REPO/src/data/index.ts" <<'TS'
export { users } from './users';
TS
    cat <<'TSX'
import { users } from './data';
export function Users() {
  return <ul>{users.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_runtime_mock_directory_users() {
    mkdir -p "$CASE_REPO/src/mocks"
    cat >"$CASE_REPO/src/mocks/users.ts" <<'TS'
export const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
TS
    cat <<'TSX'
import { users } from './mocks/users';
export function Users() {
  return <ul>{users.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_aliased_mock_users() {
    mkdir -p "$CASE_REPO/src/data"
    cat >"$CASE_REPO/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  }
}
JSON
    cat >"$CASE_REPO/src/data/users.ts" <<'TS'
export const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
TS
    cat <<'TSX'
import { users } from '@/data/users';
export function Users() {
  return <ul>{users.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_mjs_mock_users() {
    cat >"$CASE_REPO/src/data.mjs" <<'JS'
export const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
JS
    cat <<'TSX'
import { users } from './data.mjs';
export function Users() {
  return <ul>{users.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_inline_tasks() {
    cat <<'TSX'
const tasks = [{ id: 'task-1', title: 'Review proposal', status: 'Open' }];
export function Tasks() {
  return <ul>{tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>;
}
TSX
}

emit_inline_notes() {
    cat <<'TSX'
const notes = [{ id: 'note-1', title: 'Kickoff', content: 'Decide scope' }];
export function Notes() {
  return <ul>{notes.map((note) => <li key={note.id}>{note.title}</li>)}</ul>;
}
TSX
}

emit_inline_products() {
    cat <<'TSX'
const products = [{ id: 'product-1', name: 'Pro', price: 49, status: 'Active' }];
export function Products() {
  return <DataGrid rows={products} />;
}
TSX
}

emit_neutral_operational_data() {
    cat <<'TSX'
const data = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
export function Users() {
  return <DataGrid rows={data} />;
}
TSX
}

emit_static_customer_quotes() {
    cat <<'TSX'
const customerQuotes = [
  { company: 'Northstar', quote: 'Clear and fast.' },
  { company: 'Acme', quote: 'Our team stays aligned.' },
];
export function Quotes() {
  return <section>{customerQuotes.map((item) => <blockquote key={item.company}>{item.quote}</blockquote>)}</section>;
}
TSX
}

emit_documentation_code_string() {
    cat <<'TSX'
const documentation = `
const users = [{ id: 'usr-1', email: 'example@example.test', role: 'Admin' }];
export function Example() {
  return <ul>{users.map((user) => <li>{user.email}</li>)}</ul>;
}
`;
export function Docs() {
  return <pre>{documentation}</pre>;
}
TSX
}

emit_commented_example_code() {
    cat <<'TSX'
/* Example only:
const users = [{ id: 'usr-1', email: 'example@example.test', role: 'Admin' }];
const example = <ul>{users.map((user) => <li>{user.email}</li>)}</ul>;
*/
const features = [{ title: 'Private' }];
export function Features() {
  return <section>{features.map((feature) => <article key={feature.title}>{feature.title}</article>)}</section>;
}
TSX
}

emit_unrendered_map_near_jsx() {
    cat <<'TSX'
const mockUsers = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
const debugNames = mockUsers.map((user) => user.email);
export function EmptyState() {
  return <p data-debug={debugNames.length}>No users yet</p>;
}
TSX
}

emit_semicolonless_static_features() {
    cat <<'TSX'
const features = [{ title: 'Private' }, { title: 'Fast' }]
const placeholderUsers = [{ id: 'usr-1', email: 'example@example.test', role: 'Admin' }]
export function Features() {
  return <section>{features.map((feature) => <article key={feature.title}>{feature.title}</article>)}</section>
}
TSX
}

emit_static_inline_feature_status() {
    cat <<'TSX'
export function Features() {
  return <section>{[
    { id: 'private', title: 'Private', status: 'Included' },
    { id: 'fast', title: 'Fast', status: 'Included' },
  ].map((feature) => <article key={feature.id}>{feature.title}</article>)}</section>;
}
TSX
}

emit_oversized_mock_users() {
    printf '/*'
    head -c 2000100 </dev/zero | tr '\0' 'x'
    printf '*/\n'
    cat <<'TSX'
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
export function Users() {
  return <ul>{users.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_named_render_callback_users() {
    cat <<'TSX'
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
const renderUser = (user) => <li key={user.id}>{user.email}</li>;
export function Users() {
  return <ul>{users.map(renderUser)}</ul>;
}
TSX
}

emit_usememo_mock_users() {
    cat <<'TSX'
import { useMemo } from 'react';
const users = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
export function Users() {
  const visibleUsers = useMemo(() => users.filter(Boolean), []);
  return <ul>{visibleUsers.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

emit_typed_react_state_users() {
    cat <<'TSX'
import { useState } from 'react';
type User = { id: string; email: string; role: string };
export function Users() {
  const [users] = useState<User[]>([{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }]);
  return <ul>{users.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
}

council_result() {
    local repo="$1" base="$2"
    (
        cd "$repo" || exit 3
        _LOKI_RUN_START_SHA="$base"
        ITERATION_COUNT=0
        COUNCIL_STATE_DIR="$repo/.loki/council"
        LOKI_PROOF_PERSIST=0
        LOKI_PROOF_AUTH=0
        LOKI_PROOF_AUTHZ=0
        LOKI_EVIDENCE_BOOT_GATE=0
        LOKI_EVIDENCE_SECRET_GATE=0
        if council_evidence_gate >/dev/null 2>&1; then
            echo pass
        else
            echo block
        fi
    )
}

verify_result() {
    local repo="$1" base="$2"
    (
        cd "$repo" || exit 3
        VERIFY_DIFF_NAMES=$(
            {
                git diff --name-only "$base" 2>/dev/null
                git diff --name-only 2>/dev/null
                git diff --name-only --cached 2>/dev/null
                git ls-files --others --exclude-standard 2>/dev/null
            } | grep -v '^$' | grep -vE '^\.loki/' | sort -u
        )
        VERIFY_MERGE_BASE="$base"
        _VERIFY_FINDINGS_FILE="$repo/findings.tsv"
        _VERIFY_GATES_FILE="$repo/gates.tsv"
        : >"$_VERIFY_FINDINGS_FILE"
        : >"$_VERIFY_GATES_FILE"
        verify_gate_nomock "$repo" >/dev/null
        awk -F '\t' '$1 == "nomock" { print $2 }' "$_VERIFY_GATES_FILE" | tail -n 1
    )
}

run_case() {
    local name="$1" expected="$2" emitter="$3" relative="${4:-src/App.tsx}"
    local repo="$WORK_ROOT/$name"
    mkdir -p "$repo/$(dirname "$relative")" "$repo/.loki/quality" "$repo/.loki/council" "$repo/.loki/verification"
    (
        cd "$repo" || exit 3
        git init -q
        git config user.email test@example.test
        git config user.name test
        git config commit.gpgsign false
        echo base > baseline.txt
        git add baseline.txt
        git commit -qm init
    )
    local base
    base="$(git -C "$repo" rev-parse HEAD)"
    CASE_REPO="$repo" "$emitter" >"$repo/$relative"
    printf '%s\n' '{"runner":"vitest","pass":true,"status":"passed","passed_count":1,"failed_count":0}' >"$repo/.loki/quality/test-results.json"

    local council_expected verify_expected council_actual verify_actual
    if [ "$expected" = "pass" ]; then
        council_expected=pass
        verify_expected=pass
    else
        council_expected=block
        verify_expected=fail
    fi
    council_actual="$(council_result "$repo" "$base")"
    verify_actual="$(verify_result "$repo" "$base")"
    if [ "$council_actual" = "$council_expected" ] && [ "$verify_actual" = "$verify_expected" ]; then
        ok
    else
        bad "$name expected council=$council_expected verify=$verify_expected, got council=$council_actual verify=$verify_actual"
    fi
}

run_case static_features pass emit_static_features
run_case static_pricing pass emit_static_pricing
run_case form_placeholder pass emit_form_placeholder
run_case faker_users block emit_faker_users
run_case named_placeholder_users block emit_named_placeholder_users
run_case inline_orders block emit_inline_orders
run_case inline_users_grid block emit_inline_users_grid
run_case dashboard_metrics block emit_dashboard_metrics
run_case unmapped_operational pass emit_unmapped_operational_array
run_case rendered_inline_users_with_unrelated_fetch block emit_operational_with_real_source
run_case fetched_users_are_rendered pass emit_fetched_users_rendered
run_case unmapped_mock_users pass emit_unmapped_mock_users
run_case faker_docs_static_catalog pass emit_faker_docs_static_catalog
run_case unused_placeholder_users pass emit_unused_placeholder_users
run_case todo_fetch_mock_orders block emit_todo_fetch_mock_orders
run_case url_params_mock_orders block emit_url_params_mock_orders
run_case unrelated_fetch_mock_users block emit_unrelated_fetch_mock_users
run_case static_comparison_table pass emit_static_comparison_table
run_case static_pricing_table pass emit_static_pricing_table
run_case static_customer_stories pass emit_static_customer_stories
run_case datagrid_direct_users block emit_datagrid_direct_users
run_case table_datasource_users block emit_table_datasource_users
run_case vue_v_for_users block emit_vue_users src/App.vue
run_case svelte_each_users block emit_svelte_users src/App.svelte
run_case direct_inline_users block emit_direct_inline_users
run_case cross_file_mock_users block emit_cross_file_mock_users
run_case filtered_mock_users block emit_filtered_mock_users
run_case default_import_mock_users block emit_default_import_mock_users
run_case sample_features pass emit_sample_features
run_case dual_extension_users block emit_dual_extension_users
run_case large_source_tree_mock_orders block emit_large_source_tree_mock_orders src/z/App.tsx
run_case optional_mock_users block emit_optional_mock_users
run_case derived_alias_mock_users block emit_derived_alias_mock_users
run_case transformed_datagrid_users block emit_transformed_datagrid_users
run_case react_state_users block emit_react_state_users
run_case vue_ref_users block emit_vue_ref_users src/App.vue
run_case svelte_state_users block emit_svelte_state_users src/App.svelte
run_case generated_tasks block emit_generated_tasks
run_case barrel_mock_users block emit_barrel_mock_users
run_case runtime_mock_directory_users block emit_runtime_mock_directory_users
run_case aliased_mock_users block emit_aliased_mock_users
run_case mjs_mock_users block emit_mjs_mock_users
run_case inline_tasks block emit_inline_tasks
run_case inline_notes block emit_inline_notes
run_case inline_products block emit_inline_products
run_case neutral_operational_data block emit_neutral_operational_data
run_case static_customer_quotes pass emit_static_customer_quotes
run_case documentation_code_string pass emit_documentation_code_string
run_case commented_example_code pass emit_commented_example_code
run_case unrendered_map_near_jsx pass emit_unrendered_map_near_jsx
run_case semicolonless_static_features pass emit_semicolonless_static_features
run_case static_inline_feature_status pass emit_static_inline_feature_status
run_case oversized_mock_users block emit_oversized_mock_users
run_case named_render_callback_users block emit_named_render_callback_users
run_case usememo_mock_users block emit_usememo_mock_users
run_case typed_react_state_users block emit_typed_react_state_users

repo="$WORK_ROOT/changed_barrel_wiring"
mkdir -p "$repo/src/data" "$repo/.loki/quality" "$repo/.loki/council" "$repo/.loki/verification"
(
    cd "$repo" || exit 3
    git init -q
    git config user.email test@example.test
    git config user.name test
    git config commit.gpgsign false
)
cat >"$repo/src/App.tsx" <<'TSX'
import { users } from './data';
export function Users() {
  return <ul>{users.map((user) => <li key={user.id}>{user.email}</li>)}</ul>;
}
TSX
cat >"$repo/src/data/real.ts" <<'TS'
export const users = loadRemoteUsers();
TS
cat >"$repo/src/data/mock.ts" <<'TS'
export const mockUsers = [{ id: 'usr-1', email: 'ada@acme.test', role: 'Admin' }];
TS
cat >"$repo/src/data/index.ts" <<'TS'
export { users } from './real';
TS
printf '%s\n' '{"runner":"vitest","pass":true,"status":"passed","passed_count":1,"failed_count":0}' >"$repo/.loki/quality/test-results.json"
git -C "$repo" add src/App.tsx src/data/real.ts src/data/mock.ts src/data/index.ts
git -C "$repo" commit -qm fixture
base="$(git -C "$repo" rev-parse HEAD)"
cat >"$repo/src/data/index.ts" <<'TS'
export { mockUsers as users } from './mock';
TS
changed_barrel_council="$(council_result "$repo" "$base")"
changed_barrel_verify="$(verify_result "$repo" "$base")"
if [ "$changed_barrel_council" = "block" ] \
    && [ "$changed_barrel_verify" = "fail" ]; then
    ok
else
    bad "changed barrel wiring to unchanged mock data must block"
fi

dual_repo="$WORK_ROOT/dual_extension_users"
dual_files=$(
    {
        git -C "$dual_repo" diff --name-only 2>/dev/null
        git -C "$dual_repo" diff --name-only --cached 2>/dev/null
        git -C "$dual_repo" ls-files --others --exclude-standard 2>/dev/null
    } | grep -v '^$' | grep -vE '^\.loki/' | sort -u
)
dual_stable=true
for seed in 1 2 3 4 5 6 7 8 9 10; do
    dual_status=$(
        PYTHONHASHSEED="$seed" \
        _NM_FILES="$dual_files" \
        _NM_TREE="$dual_repo" \
        PYTHONNOUSERSITE=1 \
        python3 -I "$REPO_ROOT/autonomy/lib/no_mock_scan.py"
    )
    case "$dual_status" in
        FAIL:*) : ;;
        *) dual_stable=false ;;
    esac
done
if [ "$dual_stable" = "true" ]; then
    ok
else
    bad "extension resolution must be deterministic across Python hash seeds"
fi

new_receipt_repo() {
    local name="$1"
    local repo="$WORK_ROOT/$name"
    mkdir -p "$repo/src" "$repo/.loki/quality" "$repo/.loki/council" "$repo/.loki/verification"
    (
        cd "$repo" || exit 3
        git init -q
        git config user.email test@example.test
        git config user.name test
        git config commit.gpgsign false
        echo base > baseline.txt
        git add baseline.txt
        git commit -qm init
    )
    printf '%s\n' '{"runner":"vitest","pass":true,"status":"passed","passed_count":1,"failed_count":0}' >"$repo/.loki/quality/test-results.json"
    printf '%s\n' "$repo"
}

check_receipt_case() {
    local name="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        ok
    else
        bad "$name expected $expected, got $actual"
    fi
}

repo="$(new_receipt_repo clean_receipt_then_mock_mutation)"
base="$(git -C "$repo" rev-parse HEAD)"
CASE_REPO="$repo" emit_static_features >"$repo/src/App.tsx"
if [ "$(verify_result "$repo" "$base")" = "pass" ] && [ -s "$repo/.loki/verification/nomock-scan.json" ]; then
    CASE_REPO="$repo" emit_inline_orders >"$repo/src/App.tsx"
    check_receipt_case clean_receipt_then_same_base_mock_mutation block "$(council_result "$repo" "$base")"
else
    bad "clean_receipt_then_same_base_mock_mutation setup failed"
fi

repo="$(new_receipt_repo verify_then_council_mock)"
base="$(git -C "$repo" rev-parse HEAD)"
CASE_REPO="$repo" emit_inline_orders >"$repo/src/App.tsx"
if [ "$(verify_result "$repo" "$base")" = "fail" ] && [ -s "$repo/.loki/verification/nomock-scan.json" ]; then
    check_receipt_case verify_then_council_mock block "$(council_result "$repo" "$base")"
else
    bad "verify_then_council_mock setup failed"
fi

repo="$(new_receipt_repo unstamped_clean_receipt_over_mock)"
base="$(git -C "$repo" rev-parse HEAD)"
CASE_REPO="$repo" emit_inline_orders >"$repo/src/App.tsx"
printf '%s\n' '{"schema_version":2,"scanned":1,"hit":false}' >"$repo/.loki/verification/nomock-scan.json"
check_receipt_case unstamped_clean_receipt_over_current_mock block "$(council_result "$repo" "$base")"

repo="$(new_receipt_repo forged_clean_receipt_over_mock)"
base="$(git -C "$repo" rev-parse HEAD)"
CASE_REPO="$repo" emit_inline_orders >"$repo/src/App.tsx"
printf '{"schema_version":2,"scanned":1,"hit":false,"base_sha":"%s","source_digest":"forged"}\n' "$base" >"$repo/.loki/verification/nomock-scan.json"
check_receipt_case matching_base_forged_clean_receipt_over_current_mock block "$(council_result "$repo" "$base")"

repo="$(new_receipt_repo stale_hit_receipt_over_clean)"
base="$(git -C "$repo" rev-parse HEAD)"
CASE_REPO="$repo" emit_static_features >"$repo/src/App.tsx"
printf '%s\n' '{"schema_version":2,"scanned":1,"hit":true,"file":"src/App.tsx","line":1,"snippet":"old","base_sha":"old"}' >"$repo/.loki/verification/nomock-scan.json"
check_receipt_case stale_hit_receipt_over_current_clean_source pass "$(council_result "$repo" "$base")"

repo="$(new_receipt_repo malformed_receipt_over_clean)"
base="$(git -C "$repo" rev-parse HEAD)"
CASE_REPO="$repo" emit_static_features >"$repo/src/App.tsx"
printf '%s\n' '{"scanned":"1","hit":"false"}' >"$repo/.loki/verification/nomock-scan.json"
check_receipt_case malformed_typed_receipt_does_not_override_current_source pass "$(council_result "$repo" "$base")"

repo="$(new_receipt_repo project_scanner_fallback)"
base="$(git -C "$repo" rev-parse HEAD)"
printf '%s\n' changed >>"$repo/baseline.txt"
mkdir -p "$repo/autonomy/lib" "$WORK_ROOT/external-council"
cat >"$repo/autonomy/lib/no_mock_scan.py" <<'PY'
#!/usr/bin/env python3
from pathlib import Path
Path("project-scanner-ran").write_text("unsafe", encoding="utf-8")
print("PASS:1")
PY
chmod +x "$repo/autonomy/lib/no_mock_scan.py"
cp "$COUNCIL_MODULE" "$WORK_ROOT/external-council/completion-council.sh"
fallback_log="$repo/fallback.log"
fallback_result=$(
    (
        cd "$repo" || exit 3
        # shellcheck disable=SC1090
        source "$WORK_ROOT/external-council/completion-council.sh" 2>/dev/null || true
        log_warn() { printf '%s\n' "$*" >>"$fallback_log"; }
        _LOKI_RUN_START_SHA="$base"
        ITERATION_COUNT=0
        COUNCIL_STATE_DIR="$repo/.loki/council"
        LOKI_PROOF_PERSIST=0
        LOKI_PROOF_AUTH=0
        LOKI_EVIDENCE_BOOT_GATE=0
        LOKI_EVIDENCE_SECRET_GATE=0
        if council_evidence_gate >/dev/null 2>&1; then
            printf '%s\n' pass
        else
            printf '%s\n' block
        fi
    )
)
if [ "$fallback_result" = "pass" ] \
    && [ ! -e "$repo/project-scanner-ran" ] \
    && grep -q 'scanner_unavailable' "$fallback_log"; then
    ok
else
    bad "project-local scanner fallback must remain unused and report scanner_unavailable"
fi

repo="$(new_receipt_repo inherited_pythonpath_isolation)"
base="$(git -C "$repo" rev-parse HEAD)"
CASE_REPO="$repo" emit_static_features >"$repo/src/App.tsx"
cat >"$repo/sitecustomize.py" <<'PY'
from pathlib import Path
Path("python-startup-hook-ran").write_text("unsafe", encoding="utf-8")
PY
isolated_verify="$(PYTHONPATH="$repo" verify_result "$repo" "$base")"
isolated_council="$(PYTHONPATH="$repo" council_result "$repo" "$base")"
if [ "$isolated_verify" = "pass" ] \
    && [ "$isolated_council" = "pass" ] \
    && [ ! -e "$repo/python-startup-hook-ran" ]; then
    ok
else
    bad "verify and council must isolate the engine scanner from inherited PYTHONPATH"
fi

# --- Transport: the changed-file list must NOT ride in a single env string ---
# Linux caps one env/arg string at MAX_ARG_STRLEN (131071 bytes). A big changed
# set (generated source tree) therefore made execve fail with E2BIG, both gates
# captured their own "INCONCLUSIVE:detector_error" fallback, and the nomock gate
# silently passed through. macOS has NO per-string cap, so large_source_tree_*
# above stays green here even when the transport is broken; this case asserts
# the transport property itself, so it is red on every platform.
transport_probe_dir="$WORK_ROOT/_transport_probe"
mkdir -p "$transport_probe_dir"
cat >"$transport_probe_dir/python3" <<'PROBE'
#!/usr/bin/env bash
# Report the byte length of _NM_FILES as this child actually received it, then
# emit a scanner-shaped line so the caller's parser stays happy.
printf '%s\n' "${#_NM_FILES}" >"$_PROBE_OUT"
cat >/dev/null 2>&1 || true
echo "PASS:0"
PROBE
chmod +x "$transport_probe_dir/python3"

transport_repo="$WORK_ROOT/transport_env_limit"
mkdir -p "$transport_repo/src" "$transport_repo/.loki/quality" \
    "$transport_repo/.loki/council" "$transport_repo/.loki/verification"
(
    cd "$transport_repo" || exit 3
    git init -q
    git config user.email test@example.test
    git config user.name test
    git config commit.gpgsign false
    echo base >baseline.txt
    git add baseline.txt
    git commit -qm init
)
CASE_REPO="$transport_repo" emit_static_features >"$transport_repo/src/App.tsx"
# A changed-file list comfortably past the 131071-byte Linux cap. verify_gate_nomock
# reads VERIFY_DIFF_NAMES directly; council_evidence_gate computes its own union
# from git, so the same paths must exist as real untracked files for its half.
transport_names=$(awk 'BEGIN { for (i = 0; i < 6000; i++) print "src/generated/value-" i ".tsx" }')
mkdir -p "$transport_repo/src/generated"
printf '%s\n' "$transport_names" | while IFS= read -r transport_name; do
    [ -n "$transport_name" ] && : >"$transport_repo/$transport_name"
done
transport_verify_out="$WORK_ROOT/transport-env-bytes-verify"
transport_council_out="$WORK_ROOT/transport-env-bytes-council"

rm -f "$transport_verify_out"
(
    cd "$transport_repo" || exit 3
    export PATH="$transport_probe_dir:$PATH"
    export _PROBE_OUT="$transport_verify_out"
    VERIFY_DIFF_NAMES="$transport_names"
    VERIFY_MERGE_BASE=""
    _VERIFY_FINDINGS_FILE="$transport_repo/findings.tsv"
    _VERIFY_GATES_FILE="$transport_repo/gates.tsv"
    verify_gate_nomock "$transport_repo" >/dev/null 2>&1
)
transport_verify_bytes=$(cat "$transport_verify_out" 2>/dev/null || echo unset)
[ -n "$transport_verify_bytes" ] || transport_verify_bytes="unset"

rm -f "$transport_council_out"
(
    cd "$transport_repo" || exit 3
    _LOKI_RUN_START_SHA="$(git -C "$transport_repo" rev-parse HEAD)"
    ITERATION_COUNT=0
    COUNCIL_STATE_DIR="$transport_repo/.loki/council"
    LOKI_PROOF_PERSIST=0
    LOKI_PROOF_AUTH=0
    LOKI_PROOF_AUTHZ=0
    LOKI_EVIDENCE_BOOT_GATE=0
    LOKI_EVIDENCE_SECRET_GATE=0
    export PATH="$transport_probe_dir:$PATH"
    export _PROBE_OUT="$transport_council_out"
    council_evidence_gate >/dev/null 2>&1
)
transport_council_bytes=$(cat "$transport_council_out" 2>/dev/null || echo unset)
[ -n "$transport_council_bytes" ] || transport_council_bytes="unset"

if [ "$transport_verify_bytes" = "0" ] && [ "$transport_council_bytes" = "0" ]; then
    ok
else
    bad "changed-file list must not exceed the Linux env-string cap (verify sent ${transport_verify_bytes} bytes, council sent ${transport_council_bytes} bytes; limit 131071)"
fi

# --- Scanner must survive every stdin shape a caller can hand it ---
# The stdin transport must not make the scanner fragile: a closed stdin leaves
# sys.stdin as None in Python, and an uncaught error there reads back to the
# gate as "INCONCLUSIVE:detector_error" -- the same silent pass-through the
# transport fix exists to remove. Env-var input must keep working in all shapes.
stdin_repo="$WORK_ROOT/scanner_stdin_shapes"
mkdir -p "$stdin_repo/src"
CASE_REPO="$stdin_repo" emit_inline_orders >"$stdin_repo/src/App.tsx"
stdin_shapes_ok=true
stdin_piped=$(printf 'src/App.tsx\n' | _NM_TREE="$stdin_repo" python3 -I "$REPO_ROOT/autonomy/lib/no_mock_scan.py" 2>/dev/null)
stdin_devnull=$(_NM_FILES="src/App.tsx" _NM_TREE="$stdin_repo" python3 -I "$REPO_ROOT/autonomy/lib/no_mock_scan.py" </dev/null 2>/dev/null)
stdin_closed=$(_NM_FILES="src/App.tsx" _NM_TREE="$stdin_repo" python3 -I "$REPO_ROOT/autonomy/lib/no_mock_scan.py" 0<&- 2>/dev/null)
for stdin_status in "$stdin_piped" "$stdin_devnull" "$stdin_closed"; do
    case "$stdin_status" in
        FAIL:src/App.tsx:*) : ;;
        *) stdin_shapes_ok=false ;;
    esac
done
if [ "$stdin_shapes_ok" = "true" ]; then
    ok
else
    bad "scanner must detect the same hit over piped, /dev/null, and closed stdin (got '$stdin_piped' / '$stdin_devnull' / '$stdin_closed')"
fi

echo "test-nomock-data-render: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
