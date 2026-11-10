import { createToolkitAuthPlugin } from "@agent-native/toolkit/app/auth/server";

export default createToolkitAuthPlugin({
  workspaceAppPublicPaths: ["/"],
  // The invitation page only reads a fragment token into tab storage and
  // calls an authenticated action. Keeping it public lets signed-out
  // recipients preserve the token across sign-in instead of losing it.
  publicPaths: ["/invitations/accept"],
  rootAuth: true,
  marketing: false,
});
