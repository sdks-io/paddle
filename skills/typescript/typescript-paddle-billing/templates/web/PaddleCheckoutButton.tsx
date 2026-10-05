"use client";

/**
 * React example: a "Subscribe" button and the post-checkout wait.
 *
 * Flow:
 *  1. Click → Paddle.js overlay checkout with the price and the user's id in customData.
 *  2. On `checkout.completed` → show "Setting up your account…" and poll
 *     GET /api/billing/entitlement until hasAccess is true (the webhook writes it,
 *     shortly after payment). The event itself grants nothing.
 *
 * Several buttons can share a page: each reacts only to the checkout it opened.
 */
import { useEffect, useRef, useState } from "react";
import type { PaddleEventData } from "@paddle/paddle-js";
import { addPaddleEventListener, getPaddle, openCheckout, type PaddleBrowserConfig } from "./paddle-browser.js";

interface Props {
  config: PaddleBrowserConfig;         // { clientToken, environment, customerId? }
  priceId: string;
  userId: string;
  userEmail: string;
  onActivated?: () => void;
}

type Phase = "idle" | "open" | "provisioning" | "done" | "error" | "openFailed";

const POLL_INTERVAL_MS = 2000;
const POLL_ATTEMPTS = 30; // ~60 s

export function PaddleCheckoutButton({ config, priceId, userId, userEmail, onActivated }: Props) {
  const [phase, setPhaseState] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latest props, read by the listener without re-registering it (a new object from the parent must not stop polling).
  const configRef = useRef(config);
  const onActivatedRef = useRef(onActivated);
  configRef.current = config;
  onActivatedRef.current = onActivated;

  const setPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  };

  const stopPolling = () => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
  };

  const startPolling = () => {
    stopPolling();
    let attempts = 0;
    pollTimer.current = setInterval(async () => {
      attempts += 1;
      try {
        const res = await fetch("/api/billing/entitlement", { credentials: "include" });
        if (res.ok) {
          const ent = (await res.json()) as { hasAccess: boolean };
          if (ent.hasAccess && phaseRef.current === "provisioning") {
            stopPolling();
            setPhase("done");
            onActivatedRef.current?.();
            return;
          }
        }
      } catch {
        // network error: keep polling until the attempts run out
      }
      if (attempts >= POLL_ATTEMPTS && phaseRef.current === "provisioning") {
        // No webhook yet: tell the user payment was received and access follows shortly; log for ops.
        stopPolling();
        setPhase("error");
      }
    }, POLL_INTERVAL_MS);
  };

  useEffect(() => {
    void getPaddle(configRef.current); // load Paddle.js early; idempotent
    const remove = addPaddleEventListener((event: PaddleEventData) => {
      if (phaseRef.current !== "open") return; // a checkout this button did not open
      if (event.name === "checkout.completed") {
        setPhase("provisioning");
        startPolling();
      } else if (event.name === "checkout.closed") {
        setPhase("idle");
      }
    });
    return () => {
      remove();
      stopPolling();
    };
  }, []);

  const subscribe = async () => {
    setPhase("open");
    try {
      await openCheckout(configRef.current, {
        items: [{ priceId, quantity: 1 }],
        userId,
        customer: configRef.current.customerId ? { id: configRef.current.customerId } : { email: userEmail },
      });
    } catch {
      setPhase("openFailed"); // Paddle.js did not load or refused the checkout; nothing was paid
    }
  };

  if (phase === "provisioning") return <p>Payment received. Setting up your account…</p>;
  if (phase === "done") return <p>You're all set.</p>;
  if (phase === "error") return <p>Payment received, but activation is taking longer than usual. You'll have access shortly; contact support if not.</p>;
  return (
    <>
      {phase === "openFailed" && <p>Checkout could not open. Please try again.</p>}
        <button type="button" onClick={subscribe} disabled={phase === "open"}>
        Subscribe
      </button>
    </>
  );
}
