/**
 * Server-side copy for every automatic notification, in the user's preferred language.
 * Kept short: lock screens show ~40 chars of title and ~100 of body.
 */
export type Lang = 'en' | 'hi';

export type TemplateInput =
  | { type: 'CHAT_MESSAGE'; senderName: string | null; preview: string }
  | { type: 'VENDOR_STATUS'; status: string; reason?: string | null }
  | { type: 'PRODUCT_MODERATED'; productName: string; removed: boolean; reason?: string | null }
  | { type: 'SUPPORT_UPDATE'; subject: string; status: string; note?: string | null }
  | { type: 'REPORT_RESOLVED'; status: string };

export interface Rendered {
  title: string;
  body: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function vendorStatus(lang: Lang, status: string, reason: string): Rendered {
  const en: Record<string, Rendered> = {
    APPROVED: { title: 'Your shop is approved 🎉', body: 'Customers near you can now find your shop on Milkore.' },
    REJECTED: { title: 'Your shop needs changes', body: `Reason: ${reason}. Please update your details and submit again.` },
    SUSPENDED: { title: 'Your shop is suspended', body: `Reason: ${reason}. Contact Milkore support for help.` },
    PENDING: { title: 'Your shop is under review', body: 'We will let you know as soon as it is approved.' },
  };
  const hi: Record<string, Rendered> = {
    APPROVED: { title: 'आपकी दुकान स्वीकृत हो गई 🎉', body: 'अब आस-पास के ग्राहक Milkore पर आपकी दुकान देख सकते हैं।' },
    REJECTED: { title: 'आपकी दुकान में बदलाव चाहिए', body: `कारण: ${reason}। जानकारी ठीक करके फिर से भेजें।` },
    SUSPENDED: { title: 'आपकी दुकान निलंबित है', body: `कारण: ${reason}। मदद के लिए Milkore सहायता से संपर्क करें।` },
    PENDING: { title: 'आपकी दुकान की जाँच हो रही है', body: 'स्वीकृत होते ही हम आपको बताएँगे।' },
  };
  const table = lang === 'hi' ? hi : en;
  return table[status] ?? table.PENDING!;
}

function supportStatus(lang: Lang, status: string): string {
  const en: Record<string, string> = { OPEN: 'reopened', IN_PROGRESS: 'we are working on it', CLOSED: 'resolved' };
  const hi: Record<string, string> = { OPEN: 'फिर से खोला गया', IN_PROGRESS: 'हम इस पर काम कर रहे हैं', CLOSED: 'हल हो गया' };
  return (lang === 'hi' ? hi : en)[status] ?? status;
}

export function renderTemplate(lang: Lang, input: TemplateInput): Rendered {
  const hi = lang === 'hi';
  let r: Rendered;
  switch (input.type) {
    case 'CHAT_MESSAGE':
      r = { title: input.senderName || (hi ? 'नया संदेश' : 'New message'), body: input.preview };
      break;
    case 'VENDOR_STATUS':
      r = vendorStatus(lang, input.status, input.reason?.trim() || (hi ? 'बताया नहीं गया' : 'not given'));
      break;
    case 'PRODUCT_MODERATED':
      r = input.removed
        ? hi
          ? { title: 'एक उत्पाद छिपाया गया', body: `"${input.productName}" को Milkore ने छिपा दिया। कारण: ${input.reason ?? '-'}` }
          : { title: 'A product was hidden', body: `"${input.productName}" was hidden by Milkore. Reason: ${input.reason ?? '-'}` }
        : hi
          ? { title: 'उत्पाद फिर से दिख रहा है', body: `"${input.productName}" अब ग्राहकों को फिर से दिख रहा है।` }
          : { title: 'Product restored', body: `"${input.productName}" is visible to customers again.` };
      break;
    case 'SUPPORT_UPDATE': {
      const status = supportStatus(lang, input.status);
      const note = input.note?.trim();
      r = hi
        ? { title: 'आपके सहायता अनुरोध पर अपडेट', body: note ? `${input.subject}: ${note}` : `${input.subject}: ${status}` }
        : { title: 'Update on your support request', body: note ? `${input.subject}: ${note}` : `${input.subject}: ${status}` };
      break;
    }
    case 'REPORT_RESOLVED':
      r =
        input.status === 'RESOLVED'
          ? hi
            ? { title: 'आपकी शिकायत के लिए धन्यवाद', body: 'हमने आपकी शिकायत की जाँच करके कार्रवाई की है।' }
            : { title: 'Thanks for your report', body: 'We reviewed your report and took action.' }
          : hi
            ? { title: 'आपकी शिकायत के लिए धन्यवाद', body: 'हमने आपकी शिकायत की जाँच कर ली है।' }
            : { title: 'Thanks for your report', body: 'We have reviewed your report.' };
      break;
  }
  return { title: clip(r.title, 120), body: clip(r.body, 500) };
}
