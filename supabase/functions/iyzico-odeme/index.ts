// KolayCafe - İyzico Ödeme Edge Function
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
const CHECKOUT_URI = "/payment/iyzipos/checkoutform/initialize/auth/ecom";
const DETAIL_URI   = "/payment/iyzipos/checkoutform/auth/ecom/detail";

// iyzico isteklerinde zaman aşımı + geçici ağ hatalarında (örn. "Connection reset by
// peer") otomatik tekrar deneme. Her iki uç da (form oluşturma, sonuç sorgulama) kart
// çekmez/idempotenttir, bu yüzden tekrar denemek mükerrer ödeme riski taşımaz.
const IYZICO_TIMEOUT_MS = 15000;
const IYZICO_MAX_DENEME = 3;
const IYZICO_TEMEL_GECIKME_MS = 400;
const GECICI_HATA_DESENLERI = [/connection reset/i, /reset by peer/i, /timed out/i, /timeout/i, /client error \(connect\)/i, /network/i, /EOF/i, /50[234]/];

function gecikme(ms: number) { return new Promise(r => setTimeout(r, ms)); }

type IyzicoSonuc = { res?: Response; hata?: string; gecici: boolean; deneme: number };

async function iyzicoIstegiGonder(url: string, init: RequestInit, islemAdi: string): Promise<IyzicoSonuc> {
  let sonHata = "";
  for (let deneme = 1; deneme <= IYZICO_MAX_DENEME; deneme++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(IYZICO_TIMEOUT_MS) });
      if (res.status >= 500 && deneme < IYZICO_MAX_DENEME) {
        console.warn(`[iyzico:${islemAdi}] deneme ${deneme}/${IYZICO_MAX_DENEME}: HTTP ${res.status}, tekrar denenecek`);
        await gecikme(IYZICO_TEMEL_GECIKME_MS * 2 ** (deneme - 1));
        continue;
      }
      return { res, gecici: false, deneme };
    } catch (err) {
      sonHata = err instanceof Error ? err.message : String(err);
      const gecici = GECICI_HATA_DESENLERI.some(d => d.test(sonHata));
      console.error(`[iyzico:${islemAdi}] deneme ${deneme}/${IYZICO_MAX_DENEME} hata (${gecici ? "geçici" : "kalıcı"}):`, sonHata);
      if (!gecici || deneme === IYZICO_MAX_DENEME) return { hata: sonHata, gecici, deneme };
      await gecikme(IYZICO_TEMEL_GECIKME_MS * 2 ** (deneme - 1));
    }
  }
  return { hata: sonHata, gecici: true, deneme: IYZICO_MAX_DENEME };
}

async function hataLogla(sb: ReturnType<typeof createClient>, veri: Record<string, unknown>) {
  try { await sb.from("iyzico_hata_loglari").insert({ olusturulma: new Date().toISOString(), ...veri }); }
  catch (e) { console.error("[iyzico] hata log yazılamadı:", e instanceof Error ? e.message : e); }
}

async function iyzicoAuth(ak:string,sk:string,rnd:string,uri:string,body:object):Promise<string>{
  const enc=new TextEncoder();
  const k=await crypto.subtle.importKey("raw",enc.encode(sk),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const s=await crypto.subtle.sign("HMAC",k,enc.encode(rnd+uri+JSON.stringify(body)));
  const hex=Array.from(new Uint8Array(s)).map(b=>b.toString(16).padStart(2,"0")).join("");
  return "IYZWSv2 "+btoa(`apiKey:${ak}&randomKey:${rnd}&signature:${hex}`);
}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
  const AK=Deno.env.get("IYZICO_API_KEY")!,SK=Deno.env.get("IYZICO_SECRET_KEY")!;
  const BASE=Deno.env.get("IYZICO_BASE_URL")??"https://api.iyzipay.com";
  const sb=createClient(Deno.env.get("SB_URL")!,Deno.env.get("SB_SERVICE_KEY")!);

  const url = new URL(req.url);
  if (url.searchParams.get("action") === "ping") {
    // iyzico'ya Supabase Edge Runtime'ın kendi ağından erişilebilirliği test eder —
    // yerel makineden atılan curl/telnet farklı bir ağ yolundan gittiği için gerçek
    // hatayı yakalamayabilir.
    const t0 = Date.now();
    const sonuc = await iyzicoIstegiGonder(BASE, { method: "GET" }, "ping");
    return new Response(JSON.stringify({
      ok: !sonuc.hata, sureMs: Date.now() - t0, deneme: sonuc.deneme,
      httpStatus: sonuc.res?.status, hata: sonuc.hata, gecici: sonuc.gecici,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const contentType=req.headers.get("content-type")??"";
  if(req.method==="POST"&&contentType.includes("application/x-www-form-urlencoded")){
    const text=await req.text();
    const params=new URLSearchParams(text);
    const token=params.get("token");
    console.log("callback token:",token);
    if(!token)return new Response("token yok",{status:400});

    const rnd=`${Date.now()}${Math.random().toString(36).slice(2,6)}`;
    const convId=`kc_callback_${Date.now()}`;
    const reqObj={locale:"tr",conversationId:convId,token};
    const auth=await iyzicoAuth(AK,SK,rnd,DETAIL_URI,reqObj);

    const sonuc = await iyzicoIstegiGonder(`${BASE}${DETAIL_URI}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": auth, "x-iyzi-rnd": rnd, "x-iyzi-client-version": "iyzipay-node-2.0.65" },
      body: JSON.stringify(reqObj),
    }, "callback-detail");

    if (sonuc.hata) {
      // Ödeme durumu doğrulanamadı: "başarılı" diye yönlendirip planı güncellemeden
      // bırakmak yerine, kullanıcıyı "doğrulanıyor" ekranına gönderip destek/manuel
      // kontrol için iz bırakıyoruz.
      await hataLogla(sb, { conversation_id: convId, token, islem: "callback-detail", deneme_sayisi: sonuc.deneme, hata_mesaji: sonuc.hata, gecici_mi: sonuc.gecici });
      return new Response(null, { status: 303, headers: { ...corsHeaders, "Location": "https://kolaycafe.com/app/index.html?odeme=dogrulaniyor" } });
    }

    const d=await sonuc.res!.json();
    console.log("sonuc tam:",JSON.stringify(d));

    if(d.paymentStatus==="SUCCESS"){
      const basketId=d.basketId??"";
      const kafeId=basketId.replace("kafe_","");
      console.log("basketId:",basketId,"kafeId:",kafeId);

      if(kafeId){
        // Mevcut kafe bilgilerini çek
        const{data:kafe}=await sb.from("kafeler")
          .select("odeme_plan,odeme_donem,plan_bitis,plan_donem,plan")
          .eq("id",kafeId).single();

        const yeniPlan  = kafe?.odeme_plan  ?? "start";
        const yeniDonem = kafe?.odeme_donem ?? "aylik";
        const gun       = yeniDonem === "yillik" ? 365 : 30;
        const eskiBitis = kafe?.plan_bitis ? new Date(kafe.plan_bitis) : null;
        const eskiPlan  = kafe?.plan ?? "deneme";
        const simdi     = new Date();

        // Bitiş tarihi hesaplama:
        // Deneme planındaysa veya süresi dolmuşsa → bugünden başlat
        // Aktif ücretli aboneyse → mevcut bitiş üzerine ekle (kalan günler korunur)
        // Örnek: 3 ay kalan + 12 ay yenileme = 15 ay toplam
        const aktifAbonelik = eskiPlan !== "deneme" && eskiBitis !== null && eskiBitis > simdi;
        const baslangic = aktifAbonelik ? new Date(eskiBitis) : new Date();
        baslangic.setDate(baslangic.getDate() + gun);

        console.log("Plan:",yeniPlan,"Dönem:",yeniDonem,"Eski plan:",eskiPlan,"Aktif abonelik:",aktifAbonelik,"Yeni bitiş:",baslangic.toISOString());

        const{error}=await sb.from("kafeler").update({
          plan:             yeniPlan,
          plan_bitis:       baslangic.toISOString(),
          plan_donem:       yeniDonem,
          odeme_bekliyor:   false,
          odeme_bekliyor_zaman: null,
          odeme_conversation_id: null,
          son_odeme:        new Date().toISOString(),
          son_odeme_tutar:  parseFloat(d.paidPrice??"0"),
        }).eq("id",kafeId);
        await sb.from("iyzico_islemler").insert({kafe_id:kafeId,plan:yeniPlan,donem:yeniDonem,tutar:parseFloat(d.paidPrice??"0"),durum:"basarili",odeme_id:d.paymentId?.toString()??"",kart_token:d.token??""});
        console.log("Güncelleme:",error?"HATA:"+error.message:"BAŞARILI");
      }
    }
    return new Response(null,{status:303,headers:{...corsHeaders,"Location":"https://kolaycafe.com/app/index.html?odeme=basarili"}});
  }

  try{
    const body=await req.json();const{action}=body;
    if(action==="baslat"){
      const{kafeId,kafeAdi,email,telefon,plan,donem,aiEklendi,callbackUrl}=body;
      const FIYAT:Record<string,number>={start:299,grow:399,gold:499,platin:599,ultra:699,elite:799,pro:899};
      const AI=399,aylik=FIYAT[plan]??299;
      const pF=donem==="yillik"?Math.round(aylik*.8):aylik;
      const aF=aiEklendi?(donem==="yillik"?Math.round(AI*.8):AI):0;
      const top=pF+aF;
      const topStr=donem==="yillik"?(top*12).toFixed(2):top.toFixed(2);
      const rnd=`${Date.now()}${Math.random().toString(36).slice(2,6)}`;
      const convId=`kc_${kafeId}_${Date.now()}`;
      let tel=(telefon??"").replace(/\s/g,"");
      if(tel.startsWith("05"))tel="+9"+tel;else if(tel.startsWith("5"))tel="+90"+tel;else if(!tel.startsWith("+"))tel="+905000000000";
      const reqObj={locale:"tr",conversationId:convId,price:topStr,paidPrice:topStr,currency:"TRY",
        basketId:`kafe_${kafeId}`,paymentGroup:"PRODUCT",
        callbackUrl:callbackUrl??"https://sjfcdthwlwmbdmcevobv.supabase.co/functions/v1/iyzico-odeme",
        enabledInstallments:[1,2,3,6],
        buyer:{id:kafeId,name:(kafeAdi??"Kafe").split(" ")[0],surname:(kafeAdi??"Kafe Sahibi").split(" ").slice(1).join(" ")||"Sahibi",gsmNumber:tel,email:email??"kafe@kolaycafe.com",identityNumber:"74300864791",registrationAddress:"Turkiye",ip:req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()||"85.34.78.112",city:"Istanbul",country:"Turkey",zipCode:"34000"},
        shippingAddress:{contactName:kafeAdi??"Kafe",city:"Istanbul",country:"Turkey",address:"Turkiye",zipCode:"34000"},
        billingAddress:{contactName:kafeAdi??"Kafe",city:"Istanbul",country:"Turkey",address:"Turkiye",zipCode:"34000"},
        basketItems:[{id:`plan_${plan}`,name:`KolayCafe ${plan.toUpperCase()} ${donem==="yillik"?"Yillik":"Aylik"}`,category1:"Yazilim",itemType:"VIRTUAL",price:topStr}]};
      const auth=await iyzicoAuth(AK,SK,rnd,CHECKOUT_URI,reqObj);
      console.log("istek:",BASE+CHECKOUT_URI,"plan:",plan,"tutar:",topStr);

      const sonuc = await iyzicoIstegiGonder(`${BASE}${CHECKOUT_URI}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": auth, "x-iyzi-rnd": rnd, "x-iyzi-client-version": "iyzipay-node-2.0.65" },
        body: JSON.stringify(reqObj),
      }, "checkout-baslat");

      if (sonuc.hata) {
        await hataLogla(sb, { kafe_id: kafeId, conversation_id: convId, islem: "checkout-baslat", deneme_sayisi: sonuc.deneme, hata_mesaji: sonuc.hata, gecici_mi: sonuc.gecici });
        const kullaniciMesaji = sonuc.gecici
          ? "Ödeme sağlayıcısına şu an ulaşılamıyor, lütfen birkaç dakika sonra tekrar deneyin."
          : "Ödeme başlatılamadı, lütfen tekrar deneyin.";
        return new Response(JSON.stringify({ ok: false, hata: kullaniciMesaji, gecici: sonuc.gecici }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const iyziData=await sonuc.res!.json();
      console.log("yanit:",JSON.stringify(iyziData).substring(0,300));
      if(iyziData.status!=="success")return new Response(JSON.stringify({ok:false,hata:iyziData.errorMessage??"İyzico hatası",errorCode:iyziData.errorCode,detay:iyziData}),{status:400,headers:{...corsHeaders,"Content-Type":"application/json"}});
      await sb.from("kafeler").update({odeme_conversation_id:convId,odeme_bekliyor:true,odeme_bekliyor_zaman:new Date().toISOString(),odeme_plan:plan,odeme_donem:donem}).eq("id",kafeId);
      return new Response(JSON.stringify({ok:true,checkoutFormContent:iyziData.checkoutFormContent,token:iyziData.token,conversationId:convId}),{headers:{...corsHeaders,"Content-Type":"application/json"}});
    }
    return new Response(JSON.stringify({ok:false,hata:"Geçersiz action: "+action}),{status:400,headers:{...corsHeaders,"Content-Type":"application/json"}});
  }catch(err){
    const msg=err instanceof Error?err.message:String(err);
    console.error("Hata:",msg);
    return new Response(JSON.stringify({ok:false,hata:msg}),{status:500,headers:{...corsHeaders,"Content-Type":"application/json"}});
  }
});
