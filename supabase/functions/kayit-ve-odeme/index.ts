import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── İyzico config ──────────────────────────────────────────────
const IYZICO_BASE    = 'https://api.iyzipay.com'
const IYZICO_KEY     = Deno.env.get('IYZICO_API_KEY')!
const IYZICO_SECRET  = Deno.env.get('IYZICO_SECRET_KEY')!
const CALLBACK_URL   = Deno.env.get('IYZICO_CALLBACK_URL')!  // örn: https://sjfcdthwlwmbdmcevobv.supabase.co/functions/v1/iyzico-odeme?source=callback

// ── Plan fiyatları ─────────────────────────────────────────────
const PLAN_PRICES: Record<string, number> = {
  gold: 499, platin: 599, ultra: 699, elite: 799, pro: 899
}
const AI_PRICE = 399

// ── İyzico HMAC imza ───────────────────────────────────────────
async function iyzicoSign(body: string, randomStr: string): Promise<string> {
  const payload = IYZICO_KEY + randomStr + body
  const key     = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(IYZICO_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  const b64  = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return `apiKey:${IYZICO_KEY}&randomKey:${randomStr}&signature:${b64}`
}

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const url = new URL(req.url)

  // ── CALLBACK: iyzico'dan POST geri dönüşü ───────────────────
  if (url.searchParams.get('source') === 'callback') {
    try {
      const form   = await req.formData()
      const token  = form.get('token')?.toString() ?? ''
      const status = form.get('status')?.toString() ?? ''

      const supabase = createClient(
        Deno.env.get('SB_URL')!,
        Deno.env.get('SB_SERVICE_KEY')!
      )

      if (status === 'success' && token) {
        // Token ile ödeme detayını iyzico'dan doğrula
        const randomStr = Math.random().toString(36).substring(2)
        const bodyObj   = { locale: 'tr', conversationId: token, token }
        const bodyStr   = JSON.stringify(bodyObj)
        const authStr   = await iyzicoSign(bodyStr, randomStr)

        const verifyRes = await fetch(`${IYZICO_BASE}/payment/iyzipos/checkoutform/auth/ecom/detail`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `IYZWSv2 ${authStr}`,
          },
          body: bodyStr,
        })
        const verifyData = await verifyRes.json()

        if (verifyData.status === 'success') {
          // Kafe id'yi conversationId'den al (token'ı kayıt sırasında set ettik)
          const kafeId = verifyData.conversationId
          // Kafeyi aktifleştir
          await supabase.from('kafeler').update({
            plan: verifyData.paymentItems?.[0]?.itemId ?? 'pro',
            plan_bitis: null,         // abonelik aktif, bitiş yok
            odeme_durumu: 'aktif',
          }).eq('id', kafeId)

          return Response.redirect('https://kolaycafe.com?odeme=basarili', 302)
        }
      }

      return Response.redirect('https://kolaycafe.com?odeme=basarisiz', 302)
    } catch (err) {
      console.error('Callback error:', err)
      return Response.redirect('https://kolaycafe.com?odeme=basarisiz', 302)
    }
  }

  // ── ANA KAYIT + ÖDEME BAŞLATMA ────────────────────────────────
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, hata: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  try {
    const {
      ad, email, telefon, kafeAdi,
      plan = 'pro', donem = 'aylik', aiEklendi = false,
    } = await req.json()

    // Validasyon
    if (!ad || !email || !telefon || !kafeAdi) {
      return new Response(JSON.stringify({ ok: false, hata: 'Tüm alanlar zorunlu.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // ── Supabase service_role ile bağlan ──
    const supabase = createClient(
      Deno.env.get('SB_URL')!,
      Deno.env.get('SB_SERVICE_KEY')!
    )

    // ── Mevcut kafe kontrolü ──
    let kafeId: string | null = null
    const { data: mevcutKafe } = await supabase
      .from('kafeler')
      .select('id, plan')
      .eq('email', email)
      .maybeSingle()

    if (mevcutKafe) {
      kafeId = mevcutKafe.id
    } else {
      // ── Yeni kafe: 10 gün deneme ile oluştur ──
      const deneme_bitis = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
      const { data: yeniKafe, error: insertErr } = await supabase
        .from('kafeler')
        .insert({
          kafe_adi:     kafeAdi,
          email,
          telefon,
          plan:         'deneme',
          plan_bitis:   deneme_bitis,
          odeme_durumu: 'deneme',
          created_at:   new Date().toISOString(),
        })
        .select('id')
        .single()

      if (insertErr || !yeniKafe) {
        console.error('Insert error:', insertErr)
        return new Response(JSON.stringify({ ok: false, hata: 'Kafe kaydı oluşturulamadı.', detay: insertErr }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      kafeId = yeniKafe.id
    }

    // ── Fiyat hesaplama ──
    const aylikFiyat  = PLAN_PRICES[plan] ?? 899
    const aiFiyat     = aiEklendi ? AI_PRICE : 0
    let   toplamAylik = aylikFiyat + aiFiyat
    if (donem === 'yillik') toplamAylik = Math.round(toplamAylik * 0.8)
    const toplamFiyat = donem === 'yillik' ? toplamAylik * 12 : toplamAylik

    // ── İyzico checkout form başlat ──
    const randomStr     = Math.random().toString(36).substring(2)
    const conversationId = kafeId  // kafeId'yi conversationId olarak kullan
    const adParcalari   = ad.trim().split(' ')
    const iyzicoBody    = {
      locale:          'tr',
      conversationId,
      price:           toplamFiyat.toFixed(2),
      paidPrice:       toplamFiyat.toFixed(2),
      currency:        'TRY',
      basketId:        kafeId,
      paymentGroup:    'SUBSCRIPTION',
      callbackUrl:     CALLBACK_URL,
      enabledInstallments: [1],
      buyer: {
        id:                  kafeId,
        name:                adParcalari.slice(0, -1).join(' ') || ad,
        surname:             adParcalari.at(-1) || ad,
        gsmNumber:           telefon.startsWith('+') ? telefon : '+90' + telefon.replace(/^0/, ''),
        email,
        identityNumber:      '11111111111',
        registrationAddress: 'Türkiye',
        ip:                  '85.34.78.112',
        city:                'Istanbul',
        country:             'Turkey',
      },
      shippingAddress: {
        contactName: ad, city: 'Istanbul', country: 'Turkey', address: 'Türkiye'
      },
      billingAddress: {
        contactName: ad, city: 'Istanbul', country: 'Turkey', address: 'Türkiye'
      },
      basketItems: [
        {
          id:        plan,
          name:      `KolayCafe ${plan} - ${donem}`,
          category1: 'SaaS',
          itemType:  'VIRTUAL',
          price:     (toplamFiyat - (aiEklendi ? (donem === 'yillik' ? Math.round(aiFiyat * 0.8) * 12 : aiFiyat) : 0)).toFixed(2),
        },
        ...(aiEklendi ? [{
          id:        'ai-modul',
          name:      'AI Modül',
          category1: 'SaaS',
          itemType:  'VIRTUAL',
          price:     (donem === 'yillik' ? Math.round(aiFiyat * 0.8) * 12 : aiFiyat).toFixed(2),
        }] : []),
      ],
    }

    const bodyStr = JSON.stringify(iyzicoBody)
    const authStr = await iyzicoSign(bodyStr, randomStr)

    const iyzicoRes = await fetch(`${IYZICO_BASE}/payment/iyzipos/checkoutform/initialize/ecom`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `IYZWSv2 ${authStr}`,
      },
      body: bodyStr,
    })

    const iyzicoData = await iyzicoRes.json()

    if (iyzicoData.status !== 'success') {
      console.error('İyzico error:', iyzicoData)
      return new Response(JSON.stringify({
        ok: false,
        hata:  iyzicoData.errorMessage ?? 'İyzico ödeme formu başlatılamadı.',
        detay: iyzicoData,
      }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({
      ok:                  true,
      kafeId,
      checkoutFormContent: iyzicoData.checkoutFormContent,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err) {
    console.error('Sunucu hatası:', err)
    return new Response(JSON.stringify({ ok: false, hata: 'Sunucu hatası.', detay: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
