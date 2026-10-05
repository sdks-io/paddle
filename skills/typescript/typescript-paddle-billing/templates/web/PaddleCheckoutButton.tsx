"use client";

/**
 * React example: a "Subscribe" button and the post-checkout wait.
 *
 * Flow:
 *  1. Click → Paddle.js overlay checkout with the price and the user's id in customData.
 *  2. On `checkout.completed` → show "Setting up your account…" and poll
 *     GET /api/billing/entitlement until hasAccess is true (the webhook writes it,
 *     shortly after payment). The event itself grants nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PaddleEventData } from "@paddle/paddle-js";
import { getPaddle, openCheckout, type PaddleBrowserConfig } from "./paddle-browser.js";

interface Props {
  config: PaddleBrowserConfig;         // { clientToken, environment, customerId? }
  priceId: string;
  userId: string;
  userEmail: string;
  onActivated?: () => void;
}

export function PaddleCheckoutButton({ config, priceId, userId, userEmail, onActivated }: Props) {
  const [phase, setPhase] = useState<"idle" | "open" | "provisioning" | "done" | "error">("idle");
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
  };

  const onEvent = useCallback((event: PaddleEventData) => {
    if (event.name === "checkout.completed") {
      setPhase("provisioning");
      stopPolling();
      let attempts = 0;
      pollTimer.current = setInterval(async () => {
        attempts += 1;
        const res = await fetch("/api/billing/entitlement", { credentials: "include" });
        const ent = (await res.json()) as { hasAccess: boolean };
        if (ent.hasAccess) {
          stopPolling();
          setPhase("done");
          onActivated?.();
        } else if (attempts >= 30) {
          // ~60 s without the webhook: tell the user payment was received and access follows shortly; log for ops.
          stopPolling();
          setPhase("error");
        }
      }, 2000);
    } else if (event.name === "checkout.closed" ) {
      setPhase((p) => (p === "open" ? "idle" : p));
    }
  }, [onActivated]);

  useEffect(() => {
    // Initialize once with the event callback; getPaddle is idempotent.
    void getPaddle({ ...config, onEvent });
    return stopPolling;
  }, [config, onEvent]);

  const subscribe = async () => {
    setPhase("open");
    try {
      await openCheckout({ ...config, onEvent }, {
        items: [{ priceId, quantity: 1 }],
        userId,
        customer: config.customerId ? { id: config.customerId } : { email: userEmail },
      });
    } catch {
      setPhase("error");
    }
  };

  if (phase === "provisioning") return <p>Payment received. Setting up your account…</p>;
  if (phase === "done") return <p>You're all set.</p>;
  if (phase === "error") return <p>Payment received, but activation is taking longer than usual. You'll have access shortly; contact support if not.</p>;
  return (
    <button type="button" onClick={subscribe} disabled={phase === "open"}>
      Subscribe
    </button>
  );
}
