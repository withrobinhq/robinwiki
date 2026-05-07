/**
 * Prompt the user for their account password.
 *
 * Returns the entered password, or `null` if the user cancelled. Call
 * sites should treat null as "abort silently".
 */
export async function passwordPromptDialog(): Promise<string | null> {
  // TODO: v1 backend: window.prompt. Replace with PasswordPromptDialog
  // component when one exists. Call sites should not change.
  return Promise.resolve(
    window.prompt('Enter your password to reveal the keypair'),
  )
}
