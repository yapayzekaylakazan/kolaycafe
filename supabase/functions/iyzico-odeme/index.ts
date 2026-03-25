// Supabase Edge Function: iyzico-odeme
// Deploy: supabase functions deploy iyzico-odeme
//
// Gerekli environment değişkenleri (supabase secrets set ile ekle):
//   IYZICO_API_KEY     = sandbox_xxx veya production_xxx
//   IYZICO_SECRET_KEY  = sandbox_xxx veya production_xxx
//   IYZICO_BASE_URL    = https://sandbox-api.iyzipay.com  (test)
//                        https://api.iyzipay.com          (canlı)
//   SUPABASE_URL       = https://xxx.supabase.co
//   SUPABASE_SERVICE_KEY = service_role key (admin işlemler için)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Web Crypto API kullanılıyor (dış import yok)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── İyzico imza üretici (Web Crypto API) ────────────────────────────────────
async function iyzicoImza(
  apiKey: string,
  secretKey: string,
  conversationId: string,
  requestBody: string
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secretKey);
  const msgData = encoder.encode(apiKey + conversationId + requestBody);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const hash = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `apiKey:${apiKey}&randomKey:${conversationId}&signature:${hash}`;
}

// ── ISO 8601 → İyzico tarih formatı ─────────────────────────────────────────
function iyzicoTarih(): string {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

// ── Ana handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    const IYZICO_API_KEY     = Deno.env.get("IYZICO_API_KEY")!;
    const IYZICO_SECRET_KEY  = Deno.env.get("IYZICO_SECRET_KEY")!;
    const IYZICO_BASE_URL    = Deno.env.get("IYZICO_BASE_URL") ?? "https://sandbox-api.iyzipay.com";
    const SUPABASE_URL       = Deno.env.get("SB_URL")!;
    const SUPABASE_SERVICE_KEY = Deno.env.get("SB_SERVICE_KEY")!;

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── ACTION: ödeme formu başlat ───────────────────────────────────────────
    if (action === "baslat") {
      const {
        kafeId,        // Supabase kafeler.id
        kafeAdi,       // kafe adı
        email,         // müşteri email
        telefon,       // müşteri tel
        plan,          // "start" | "grow" | "gold" | ...
        donem,         // "aylik" | "yillik"
        aiEklendi,     // boolean
        callbackUrl,   // ödeme sonrası yönlendirme
      } = body;

      const PLAN_FIYAT: Record<string, number> = {
        start: 299, grow: 399, gold: 499,
        platin: 599, ultra: 699, elite: 799, pro: 899,
      };
      const AI_FIYAT = 199;

      const aylikFiyat = PLAN_FIYAT[plan] ?? 299;
      const paketFiyat = donem === "yillik" ? Math.round(aylikFiyat * 0.8) : aylikFiyat;
      const aiFiyat    = aiEklendi ? (donem === "yillik" ? Math.round(AI_FIYAT * 0.8) : AI_FIYAT) : 0;
      const toplamAylik = paketFiyat + aiFiyat;
      // İyzico fiyatı kuruş değil, TL — string "299.00" formatında
      const toplamTL = donem === "yillik" ? (toplamAylik * 12).toFixed(2) : toplamAylik.toFixed(2);

      const conversationId = `kc_${kafeId}_${Date.now()}`;
      const planIsim = `KolayCafe ${plan.toUpperCase()} ${donem === "yillik" ? "Yıllık" : "Aylık"}`;

      const requestBody = {
        locale: "tr",
        conversationId,
        price: toplamTL,
        paidPrice: toplamTL,
        currency: "TRY",
        basketId: `kafe_${kafeId}`,
        paymentGroup: "SUBSCRIPTION",
        callbackUrl: callbackUrl ?? "https://kolaycafe.com/odeme-sonuc",
        enabledInstallments: [1, 2, 3, 6, 9],
        buyer: {
          id: kafeId,
          name: kafeAdi?.split(" ")[0] ?? "Kafe",
          surname: kafeAdi?.split(" ").slice(1).join(" ") || "Sahibi",
          gsmNumber: telefon ?? "+905000000000",
          email: email ?? "kafe@kolaycafe.com",
          identityNumber: "11111111111", // TCKN — gerçek sistemde kullanıcıdan alınır
          registrationDate: iyzicoTarih(),
          lastLoginDate: iyzicoTarih(),
          registrationAddress: "Türkiye",
          ip: "85.34.78.112",
          city: "Istanbul",
          country: "Turkey",
        },
        shippingAddress: {
          contactName: kafeAdi ?? "Kafe",
          city: "Istanbul",
          country: "Turkey",
          address: "Türkiye",
        },
        billingAddress: {
          contactName: kafeAdi ?? "Kafe",
          city: "Istanbul",
          country: "Turkey",
          address: "Türkiye",
        },
        basketItems: [
          {
            id: `plan_${plan}`,
            name: planIsim,
            category1: "Yazılım",
            category2: "SaaS",
            itemType: "VIRTUAL",
            price: (toplamAylik * (donem === "yillik" ? 12 : 1)).toFixed(2),
          },
        ],
      };

      const bodyStr = JSON.stringify(requestBody);

      // İyzico isteği gönder
      const iyzicoRes = await fetch(`${IYZICO_BASE_URL}/payment/iyzipos/checkoutform/initialize/auth/ecommerce`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await iyzicoImza(IYZICO_API_KEY, IYZICO_SECRET_KEY, conversationId, bodyStr),
        },
        body: bodyStr,
      });

      const iyzicoData = await iyzicoRes.json();

      if (iyzicoData.status !== "success") {
        return new Response(
          JSON.stringify({ ok: false, hata: iyzicoData.errorMessage ?? "İyzico hatası", detay: iyzicoData }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // conversationId'yi Supabase'e kaydet (webhook'ta eşleştirmek için)
      await sb.from("kafeler").update({
        odeme_conversation_id: conversationId,
        odeme_bekliyor: true,
        odeme_plan: plan,
        odeme_donem: donem,
      }).eq("id", kafeId);

      return new Response(
        JSON.stringify({
          ok: true,
          checkoutFormContent: iyzicoData.checkoutFormContent, // iframe HTML
          token: iyzicoData.token,
          conversationId,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── ACTION: ödeme sonucu kontrol (callback) ──────────────────────────────
    if (action === "sonuc") {
      const { token } = body;

      const conversationId = `sonuc_${Date.now()}`;
      const requestBody = { locale: "tr", conversationId, token };
      const bodyStr = JSON.stringify(requestBody);

      const iyzicoRes = await fetch(`${IYZICO_BASE_URL}/payment/iyzipos/checkoutform/auth/ecommerce/detail`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await iyzicoImza(IYZICO_API_KEY, IYZICO_SECRET_KEY, conversationId, bodyStr),
        },
        body: bodyStr,
      });

      const iyzicoData = await iyzicoRes.json();

      if (iyzicoData.paymentStatus !== "SUCCESS") {
        return new Response(
          JSON.stringify({ ok: false, hata: "Ödeme başarısız", detay: iyzicoData }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // basketId'den kafeId çıkar: "kafe_<uuid>"
      const basketId: string = iyzicoData.basketId ?? "";
      const kafeId = basketId.replace("kafe_", "");

      // Hangi plan/dönem bekleniyordu?
      const { data: kafe } = await sb.from("kafeler").select("odeme_plan,odeme_donem").eq("id", kafeId).single();
      const plan  = kafe?.odeme_plan  ?? "start";
      const donem = kafe?.odeme_donem ?? "aylik";

      // Plan bitiş tarihini hesapla
      const gun = donem === "yillik" ? 365 : 30;
      const bitis = new Date();
      bitis.setDate(bitis.getDate() + gun);

      // Supabase güncelle
      await sb.from("kafeler").update({
        plan,
        plan_bitis: bitis.toISOString(),
        plan_donem: donem,
        odeme_bekliyor: false,
        odeme_conversation_id: null,
        son_odeme: new Date().toISOString(),
        son_odeme_tutar: parseFloat(iyzicoData.paidPrice ?? "0"),
      }).eq("id", kafeId);

      return new Response(
        JSON.stringify({ ok: true, plan, donem, bitis: bitis.toISOString() }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ ok: false, hata: "Geçersiz action" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, hata: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
