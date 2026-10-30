import { cookies } from "next/headers";
import { getActor } from "@/lib/auth";
import { prisma } from "@/lib/db";

export type SignedInUser = { email: string };

/**
 * The person already signed in, for the public auth pages (sign in, sign up, forgot password), or null when there is no
 * live session. A GET-shaped request is used so a locked or unverified workspace still counts as signed in. Never throws:
 * outside a request (tests, prerendering) or with a stale cookie the page simply shows no notice.
 */
export async function signedInUser(): Promise<SignedInUser | null> {
  try {
    const jar = await cookies();
    const cookie = jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    if (!cookie) return null;
    const actor = await getActor(new Request("http://internal/", { headers: { cookie } }));
    const user = await prisma.user.findUnique({ where: { id: actor.userId }, select: { email: true } });
    return user ? { email: user.email } : null;
  } catch {
    return null;
  }
}
