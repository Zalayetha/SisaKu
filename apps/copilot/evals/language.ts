export type Language = "id" | "en";

// Common words of each language that are not also words of the other. Menu item names, waste
// causes and other words the Copilot keeps as they are in either language are left out.
const WORDS: Record<Language, ReadonlySet<string>> = {
  id: new Set(
    (
      "ada adalah anda belum berapa bisa bulan catatan dalam dan dapat dari dengan dikirim entri " +
      "hanya hari ini itu jadi juga kami karena kemarin kepada lalu lebih limbah menjadi minggu " +
      "outletmu pada paling penjualan penyebab perkiraan porsi saya sebanyak sekitar sementara " +
      "sudah terbuang tercatat terjual tetapi tidak untuk yang"
    ).split(" "),
  ),
  en: new Set(
    (
      "about and at been but can compared due estimated for from has have in is last mainly most " +
      "not of only our portions recorded sales see sent sold than that the there this to today " +
      "was wasted week were with yesterday you your"
    ).split(" "),
  ),
};

/** The language a reply is written in, by its common words; undefined when they do not tell. */
export function replyLanguage(reply: string): Language | undefined {
  const words = reply.toLowerCase().match(/[a-z]+/g) ?? [];
  const count = (language: Language) => words.filter((w) => WORDS[language].has(w)).length;
  const [id, en] = [count("id"), count("en")];
  return id === en ? undefined : id > en ? "id" : "en";
}
