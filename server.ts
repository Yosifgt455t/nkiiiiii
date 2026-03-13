import express from "express";
import { createServer as createViteServer } from "vite";
import Stripe from "stripe";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_mock");

// Supabase Admin Client for server-side operations
const supabaseUrl = process.env.VITE_SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const app = express();

async function startServer() {
  const PORT = 3000;

  // Logging middleware
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
  });

  // Stripe Webhook needs raw body
  app.post(
    "/api/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      console.log("Received Stripe Webhook");
      const sig = req.headers["stripe-signature"];
      let event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig as string,
          process.env.STRIPE_WEBHOOK_SECRET || ""
        );
      } catch (err: any) {
        console.error(`Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerEmail = session.customer_details?.email;
        if (customerEmail) {
          console.log(`Updating premium status for ${customerEmail} in Supabase...`);
          const { error } = await supabase
            .from('profiles')
            .update({ is_premium: true })
            .eq('email', customerEmail);
          
          if (error) console.error("Error updating premium status in Supabase:", error);
          else console.log(`User ${customerEmail} is now Premium in Supabase!`);
        }
      }

      res.json({ received: true });
    }
  );

  app.use(express.json());

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/user-status", async (req, res) => {
    const email = req.query.email as string;
    if (!email) return res.status(400).json({ error: "Email required" });
    
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('is_premium')
        .eq('email', email)
        .single();
      
      if (error) {
        console.error("Error fetching user status from Supabase:", error);
        return res.json({ isPremium: false });
      }
      res.json({ isPremium: !!data?.is_premium });
    } catch (e) {
      res.json({ isPremium: false });
    }
  });

  app.post("/api/create-checkout-session", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email required" });

      if (!process.env.STRIPE_SECRET_KEY) {
        return res.status(500).json({ error: "Stripe is not configured on the server." });
      }

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "نبراس بريميوم (Nebras Premium)",
                description: "اشتراك مدى الحياة في المدرس الخصوصي الذكي",
              },
              unit_amount: 1000, // 10.00 USD
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: email,
        success_url: `${process.env.APP_URL || req.headers.origin || "http://localhost:3000"}?success=true`,
        cancel_url: `${process.env.APP_URL || req.headers.origin || "http://localhost:3000"}?canceled=true`,
      });

      res.json({ url: session.url });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/cancel-subscription", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    try {
      const { error } = await supabase
        .from('profiles')
        .update({ is_premium: false })
        .eq('email', email);
      
      if (error) throw error;
      res.json({ success: true, message: "Subscription canceled successfully" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Error handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Unhandled Error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

// Export for Vercel
export default app;

if (process.env.NODE_ENV !== "production") {
  startServer();
} else if (process.env.VERCEL !== "1") {
  // If in production but not on Vercel (e.g. Docker/Cloud Run)
  startServer();
}
