// KolayCafe - İyzico Ödeme Edge Function
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
const CHECKOUT_URI = "/payment/iyzipos/checkoutform/initialize/auth/ecom";
const DETAIL_URI   = "/payment/iyzipos/checkoutform/auth/ecom/detail";

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
    const r=await fetch(`${BASE}${DETAIL_URI}`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":auth,"x-iyzi-rnd":rnd,"x-iyzi-client-version":"iyzipay-node-2.0.65"},body:JSON.stringify(reqObj)});
    const d=await r.json();
    console.log("sonuc tam:",JSON.stringify(d));

    if(d.paymentStatus==="SUCCESS"){
      // basketId: "kafe_ef295a16-ae13-4c5a-9de6-69143e4930d8"
      const basketId=d.basketId??"";
      const kafeId=basketId.replace("kafe_","");
      console.log("basketId:",basketId,"kafeId:",kafeId);

      if(kafeId){
        const{data:kafe}=await sb.from("kafeler").select("odeme_plan,odeme_donem").eq("id",kafeId).single();
        const plan=kafe?.odeme_plan??"start";
        const donem=kafe?.odeme_donem??"aylik";
        const gun=donem==="yillik"?365:30;
        const bitis=new Date();bitis.setDate(bitis.getDate()+gun);
        const{error}=await sb.from("kafeler").update({
          plan,plan_bitis:bitis.toISOString(),plan_donem:donem,
          odeme_bekliyor:false,odeme_conversation_id:null,
          son_odeme:new Date().toISOString(),
          son_odeme_tutar:parseFloat(d.paidPrice??"0"),
        }).eq("id",kafeId);
        console.log("Güncelleme sonucu:",error?"HATA:"+error.message:"BAŞARILI",plan,donem);
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
      const iyziRes=await fetch(`${BASE}${CHECKOUT_URI}`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":auth,"x-iyzi-rnd":rnd,"x-iyzi-client-version":"iyzipay-node-2.0.65"},body:JSON.stringify(reqObj)});
      const iyziData=await iyziRes.json();
      console.log("yanit:",JSON.stringify(iyziData).substring(0,300));
      if(iyziData.status!=="success")return new Response(JSON.stringify({ok:false,hata:iyziData.errorMessage??"İyzico hatası",errorCode:iyziData.errorCode,detay:iyziData}),{status:400,headers:{...corsHeaders,"Content-Type":"application/json"}});
      await sb.from("kafeler").update({odeme_conversation_id:convId,odeme_bekliyor:true,odeme_plan:plan,odeme_donem:donem}).eq("id",kafeId);
      return new Response(JSON.stringify({ok:true,checkoutFormContent:iyziData.checkoutFormContent,token:iyziData.token,conversationId:convId}),{headers:{...corsHeaders,"Content-Type":"application/json"}});
    }
    return new Response(JSON.stringify({ok:false,hata:"Geçersiz action: "+action}),{status:400,headers:{...corsHeaders,"Content-Type":"application/json"}});
  }catch(err){
    const msg=err instanceof Error?err.message:String(err);
    console.error("Hata:",msg);
    return new Response(JSON.stringify({ok:false,hata:msg}),{status:500,headers:{...corsHeaders,"Content-Type":"application/json"}});
  }
});
