// The CLI's connection to the API (P-96). Task B of Run 5.5 adds the client.

/** The environment a command asks for. */
export interface Selector {
  project: string;
  env: string;
}
