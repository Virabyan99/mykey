// The workspace starts here: one root, one cache, one stylesheet. Everything
// the page shows comes from the API of the origin that served it.
import { captureResetLink } from "./state/reset-link.ts";
import "./api/zod-setup.ts";
import "./styles.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./api/query.ts";
import { App } from "./app.tsx";

// Before anything is rendered or requested: a reset link's token leaves the address.
captureResetLink();

const root = document.getElementById("root");
if (root === null) throw new Error("no root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
