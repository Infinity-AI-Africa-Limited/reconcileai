import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { getLoginUrl } from "./const";
import { PortalProvider } from "./contexts/PortalContext";
import { portalHeaders, readPortalSession } from "./lib/portalRequest";
import "./index.css";

const queryClient = new QueryClient();

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  window.location.href = getLoginUrl();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      // Attach the per-POC access token (set by the POC access gate) so gated
      // POC procedures accept the request. Harmless on non-POC calls.
      //
      // And the super-admin portal tenant, on every request: the server makes
      // it the request's organisation for a super admin and ignores it for
      // everyone else (server/_core/portalView.ts). This is what scopes EVERY
      // procedure to the tenant on screen, not only the ones a page remembered
      // to pass `viewAsOrgId` to.
      headers() {
        const portal = portalHeaders(readPortalSession());
        try {
          const t = sessionStorage.getItem("poc_access_token");
          return t ? { ...portal, "x-poc-access-token": t } : portal;
        } catch {
          return portal;
        }
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <PortalProvider>
        <App />
      </PortalProvider>
    </QueryClientProvider>
  </trpc.Provider>
);
