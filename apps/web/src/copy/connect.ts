// The words of "Connect an application" (P-159): one title and one sentence
// per step. The commands themselves are the runbooks' (connect/commands.ts).
export const CONNECT_STEPS = {
  "local-get": {
    title: "Get the CLI",
    text: "Download the release and the launch wrapper, then check both files against their sums. Both lines must say OK.",
  },
  "local-install": {
    title: "Install it",
    text: "The installer checks the CLI and the Node runtime it downloads against pinned sums, writes only under your home directory and needs no root. Then put it on PATH for this shell.",
  },
  "local-name": {
    title: "Name the service and the environment",
    text: "Already filled in for this environment. Replace APP_DIR and APP_START with your application's directory and the command that starts it.",
  },
  "local-name-bare": {
    title: "Name the service and the environment",
    text: "Already filled in for this environment: the service's address, the project's id and the environment's name.",
  },
  "local-check": {
    title: "Check the endpoint",
    text: "The first line is the CLI's version; the second is the service's own answer, with no credential.",
  },
  "local-issue": {
    title: "Issue a token",
    text: "Issue a machine credential for this environment under Machine credentials. The token is shown once: copy it then.",
  },
  "local-store": {
    title: "Store the token",
    text: "Run the block, paste the token, press Enter, then Ctrl-D. The token goes into a file only you can read, and into no shell history.",
  },
  "local-start": {
    title: "Start your application",
    text: "The launcher reads the complete set and starts your application with it. If the set cannot be read completely, nothing starts: exit code 77 means the token is not accepted, 69 that the service cannot be reached.",
  },
  "local-names": {
    title: "Start a command that prints names only",
    text: "Without an application yet: a command that lists the names it was started with, never a value.",
  },
  "local-done": {
    title: "Check it worked",
    text: "Activity lists the machine's read under the credential's name.",
  },
  "server-get": {
    title: "Get the release",
    text: "On the server, download the release and the launch wrapper (or the same four files with curl, as on the other tab).",
  },
  "server-name": {
    title: "Name the application, the service and the environment",
    text: "Already filled in for this environment. Replace the APP_ values with your application's.",
  },
  "server-node": {
    title: "Check the files and fetch Node for the image",
    text: "The image installs offline, so the official Node archive goes next to the release files.",
  },
  "server-build": {
    title: "Build the image",
    text: "Your application's image, with the CLI installed in it.",
  },
  "server-store": {
    title: "Store the token on the host",
    text: "Issue a token under Machine credentials, then run the block, paste the token, press Enter and Ctrl-D.",
  },
  "server-run": {
    title: "Run the container",
    text: "The token file is mounted read-only; the other SECRETS_ settings are plain variables.",
  },
  "server-done": {
    title: "Check it worked",
    text: "Activity lists the machine's read under the credential's name.",
  },
} as const satisfies Record<string, { title: string; text: string }>;

export type ConnectStepId = keyof typeof CONNECT_STEPS;
