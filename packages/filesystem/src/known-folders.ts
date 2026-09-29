/** The Windows known folders Allaya offers by default, with the names people use for them in Bengali. */
export const KNOWN_FOLDERS = [
  { id: 'desktop', label: 'Desktop', aliases: ['ডেস্কটপ'] },
  { id: 'documents', label: 'Documents', aliases: ['ডকুমেন্টস', 'ডকুমেন্ট', 'নথি'] },
  { id: 'downloads', label: 'Downloads', aliases: ['ডাউনলোডস', 'ডাউনলোড'] },
  { id: 'pictures', label: 'Pictures', aliases: ['পিকচারস', 'ছবি'] },
  { id: 'videos', label: 'Videos', aliases: ['ভিডিওস', 'ভিডিও'] },
  { id: 'music', label: 'Music', aliases: ['মিউজিক', 'গান'] },
] as const;

export type KnownFolderId = (typeof KNOWN_FOLDERS)[number]['id'];
