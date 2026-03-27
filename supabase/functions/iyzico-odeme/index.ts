// KolayCafe - İyzico Ödeme Edge Function

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function iyzicoImza(apiKey: string, secretKey: string, randomKey: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secretKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(apiKey + randomKey + body));
  const hash = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `apiKey:${apiKey}&randomKey:${randomKey}&signature:${hash}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { action } = body;

    const API_KEY    = Deno.env.get("IYZICO_API_KEY")!;
    const SECRET_KEY = Deno.env.get("IYZICO_SECRET_KEY")!;
    const BASE_URL   = Deno.env.get("IYZICO_BASE_URL") ?? "https://sandbox-api.iyzipay.com";
    const SB_URL     = Deno.env.get("SB_URL")!;
    const SB_KEY     = Deno.env.get("SB_SERVICE_KEY")!;
    const sb         = createClient(SB_URL, SB_KEY);

    // ── ÖDEME BAŞLAT ──────────────────────────────────────────────────────────
    if (action === "baslat") {
      const { kafeId, kafeAdi, email, telefon, plan, donem, aiEklendi, callbackUrl } = body;

      const FIYAT: Record<string, number> = { start:299, grow:399, gold:499, platin:599, ultra:699, elite:799, pro:899 };
      const AI_FIYAT = 399;
      const aylik = FIYAT[plan] ?? 299;
      const paketFiyat = donem === "yillik" ? Math.round(aylik * 0.8) : aylik;
      const aiFiyat = aiEklendi ? (donem === "yillik" ? Math.round(AI_FIYAT * 0.8) : AI_FIYAT) : 0;
      const toplam = paketFiyat + aiFiyat;
      const toplamStr = donem === "yillik"
        ? (toplam * 12).toFixed(2)
        : toplam.toFixed(2);

      const randomKey = `kc${Date.now()}`;
      const convId    = `kc_${kafeId}_${Date.now()}`;

      // Telefon formatla
      let tel = (telefon ?? "").replace(/\s/g, "");
      if (tel.startsWith("05")) tel = "+9" + tel;
      else if (tel.startsWith("5")) tel = "+90" + tel;
      else if (!tel.startsWith("+")) tel = "+905000000000";

      const reqObj = {
        locale: "tr",
        conversationId: convId,
        price: toplamStr,
        paidPrice: toplamStr,
        currency: "TRY",
        basketId: `kafe_${kafeId}`,
        paymentGroup: "PRODUCT",
        callbackUrl: callbackUrl ?? "https://kolaycafe.com/app/index.html",
        enabledInstallments: [1, 2, 3, 6],
        buyer: {
          id: kafeId,
          name: (kafeAdi ?? "Kafe").split(" ")[0],
          surname: (kafeAdi ?? "Kafe Sahibi").split(" ").slice(1).join(" ") || "Sahibi",
          gsmNumber: tel,
          email: email ?? "kafe@kolaycafe.com",
          identityNumber: "74300864791",
          registrationAddress: "Turkiye",
          ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "85.34.78.112",
          city: "Istanbul",
          country: "Turkey",
          zipCode: "34000",
        },
        shippingAddress: { contactName: kafeAdi ?? "Kafe", city: "Istanbul", country: "Turkey", address: "Turkiye", zipCode: "34000" },
        billingAddress:  { contactName: kafeAdi ?? "Kafe", city: "Istanbul", country: "Turkey", address: "Turkiye", zipCode: "34000" },
        basketItems: [{
          id: `plan_${plan}`,
          name: `KolayCafe ${plan.toUpperCase()} ${donem === "yillik" ? "Yillik" : "Aylik"}`,
          category1: "Yazilim",
          itemType: "VIRTUAL",
          price: toplamStr,
        }],
      };

      const bodyStr = JSON.stringify(reqObj);
      const auth    = await iyzicoImza(API_KEY, SECRET_KEY, randomKey, bodyStr);

      console.log("İyzico istek:", BASE_URL, "plan:", plan, "tutar:", toplamStr);

      const iyziRes  = await fetch(`${BASE_URL}/payment/iyzipos/checkoutform/initialize`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": auth },
        body: bodyStr,
      });

      const iyziData = await iyziRes.json();
      console.log("İyzico yanıt:", JSON.stringify(iyziData).substring(0, 300));

      if (iyziData.status !== "success") {
        return new Response(JSON.stringify({
          ok: false,
          hata: iyziData.errorMessage ?? "İyzico hatası",
          errorCode: iyziData.errorCode,
          detay: iyziData,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      await sb.from("kafeler").update({
        odeme_conversation_id: convId,
        odeme_bekliyor: true,
        odeme_plan: plan,
        odeme_donem: donem,
      }).eq("id", kafeId);

      return new Response(JSON.stringify({
        ok: true,
        checkoutFormContent: iyziData.checkoutFormContent,
        token: iyziData.token,
        conversationId: convId,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── ÖDEME SONUÇ ───────────────────────────────────────────────────────────
    if (action === "sonuc") {
      const { token } = body;
      const randomKey = `sonuc${Date.now()}`;
      const convId    = `sonuc_${Date.now()}`;
      const reqObj    = { locale: "tr", conversationId: convId, token };
      const bodyStr   = JSON.stringify(reqObj);
      const auth      = await iyzicoImza(API_KEY, SECRET_KEY, randomKey, bodyStr);

      const iyziRes  = await fetch(`${BASE_URL}/payment/iyzipos/checkoutform/detail`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": auth },
        body: bodyStr,
      });
      const iyziData = await iyziRes.json();
      console.log("Sonuç yanıt:", JSON.stringify(iyziData).substring(0, 300));

      if (iyziData.paymentStatus !== "SUCCESS") {
        return new Response(JSON.stringify({ ok: false, hata: "Ödeme başarısız", detay: iyziData }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const kafeId = (iyziData.basketId ?? "").replace("kafe_", "");
      const { data: kafe } = await sb.from("kafeler").select("odeme_plan,odeme_donem").eq("id", kafeId).single();
      const plan  = kafe?.odeme_plan  ?? "start";
      const donem = kafe?.odeme_donem ?? "aylik";
      const gun   = donem === "yillik" ? 365 : 30;
      const bitis = new Date();
      bitis.setDate(bitis.getDate() + gun);

      await sb.from("kafeler").update({
        plan,
        plan_bitis: bitis.toISOString(),
        plan_donem: donem,
        odeme_bekliyor: false,
        odeme_conversation_id: null,
        son_odeme: new Date().toISOString(),
        son_odeme_tutar: parseFloat(iyziData.paidPrice ?? "0"),
      }).eq("id", kafeId);

      return new Response(JSON.stringify({ ok: true, plan, donem, bitis: bitis.toISOString() }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ ok: false, hata: "Geçersiz action: " + action }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Hata:", msg);
    return new Response(JSON.stringify({ ok: false, hata: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
