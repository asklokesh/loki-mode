/**
 * Hidden behavioral test for asklokesh/augmentiq#52 ("add searchbar").
 * Written from the issue text only: the dashboard shell must offer a search
 * control that a user can type into, and typing must actually search
 * (either results appear on screen or a search request is sent).
 * It does not assume any component, hook or endpoint name.
 */
import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

Element.prototype.scrollIntoView = vi.fn()

vi.mock("next/navigation", () => {
  const router = { back: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }
  return {
    usePathname: () => "/",
    useRouter: () => router,
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
    redirect: vi.fn(),
  }
})

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string } & Record<string, unknown>) => (
    <a href={typeof href === "string" ? href : "#"} {...(rest as Record<string, never>)}>
      {children}
    </a>
  ),
}))

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "test@example.com", name: "Test User", role: "admin" },
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
    login: vi.fn(),
    hasPermission: () => true,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import DashboardLayout from "@/app/(dashboard)/layout"

const SEARCH = /search|find/i

function fetchMock() {
  return vi.fn(async () =>
    new Response(JSON.stringify({ results: [], items: [], data: [], total: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  )
}

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DashboardLayout>
        <div>page body</div>
      </DashboardLayout>
    </QueryClientProvider>,
  )
}

function findSearchInput(): HTMLInputElement | null {
  const byRole = [...screen.queryAllByRole("searchbox"), ...screen.queryAllByRole("combobox"), ...screen.queryAllByRole("textbox")]
  for (const el of byRole) {
    const label = [el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("name"), el.getAttribute("type")].join(" ")
    if (el.getAttribute("type") === "search" || SEARCH.test(label) || el.getAttribute("role") === "searchbox") {
      return el as HTMLInputElement
    }
  }
  const byPlaceholder = screen.queryAllByPlaceholderText(SEARCH)
  return (byPlaceholder[0] as HTMLInputElement) ?? null
}

async function openSearch(): Promise<HTMLInputElement> {
  let input = findSearchInput()
  if (!input) {
    const trigger = screen.queryAllByRole("button", { name: SEARCH })[0]
    if (trigger) fireEvent.click(trigger)
    else fireEvent.keyDown(document, { key: "k", metaKey: true, ctrlKey: true })
    await waitFor(() => expect(findSearchInput()).not.toBeNull(), { timeout: 2000 })
    input = findSearchInput()
  }
  return input as HTMLInputElement
}

describe("issue #52: search bar in the dashboard", () => {
  beforeEach(() => {
    global.fetch = fetchMock() as unknown as typeof fetch
  })

  it("offers a search control a user can type into", async () => {
    renderShell()
    const input = await openSearch()
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { value: "Trends" } })
    expect(input.value).toBe("Trends")
  })

  it("typing a query actually searches: results render or a search request is sent", async () => {
    renderShell()
    const navLinksBefore = screen.queryAllByText("Trends").length
    const input = await openSearch()
    fireEvent.change(input, { target: { value: "Trends" } })
    await waitFor(
      () => {
        const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
        const requested = calls.some((c) => /trends/i.test(String(c[0] instanceof Request ? c[0].url : c[0])))
        const shownNow = screen.queryAllByText(/trends/i).filter((el) => !(el as HTMLElement).closest("nav")).length
        expect(requested || shownNow > 0 || screen.queryAllByText("Trends").length > navLinksBefore).toBe(true)
      },
      { timeout: 3000 },
    )
  })

  it("keeps the rest of the shell rendering (navigation still present)", async () => {
    renderShell()
    expect(within(document.body).getAllByText("Overview").length).toBeGreaterThan(0)
    expect(screen.getByText("page body")).toBeInTheDocument()
  })
})
