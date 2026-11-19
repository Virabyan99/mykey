// What anyone without a complete session sees on every path. The address
// stays as it was, so signing in leads to where the owner was going.
export function SignIn() {
  return (
    <main className="narrow">
      <h1>Sign in</h1>
      <p>The workspace opens after your password and a code from your authenticator app.</p>
    </main>
  );
}
