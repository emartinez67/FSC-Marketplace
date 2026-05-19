import { supabase } from "./supabase";
export type {
  Listing,
  Conversation,
  Message,
  Report,
  Review,
  Profile,
  Transaction,
  Notification,
  TradeOffer,
  Meetup,
} from "./database.types";

import type {
  Listing,
  Conversation,
  Message,
  Report,
  Review,
  Profile,
  Transaction,
  Notification,
  TradeOffer,
  Meetup,
} from "./database.types";

// ── Extended types ─────────────────────────────────────────────────────────────

export interface ConversationWithPreview extends Conversation {
  other_name: string;
  other_initials: string;
  last_message: string;
  last_message_time: string;
  unread_count: number;
  listing_title?: string;
  listing_price?: number;
  listing_images?: string[];
}

export interface SellerRating {
  average: number;
  count: number;
}

export interface UserRating {
  average: number;
  count: number;
  asSeller: { average: number; count: number; };
  asBuyer: { average: number; count: number; };
}

export interface TransactionWithNames extends Transaction {
  seller_name: string;
  buyer_name: string | null;
}

// ── Listings ───────────────────────────────────────────────────────────────────

export async function fetchListings(opts?: {
  category?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: string;
  savedOnly?: string[];
}) {
  let query = supabase
    .from("listings")
    .select("*")
    .order("created_at", { ascending: false });

  if (opts?.category && opts.category !== "All") {
    query = query.eq("category", opts.category);
  }
  if (opts?.search) {
    query = query.ilike("title", `%${opts.search}%`);
  }
  if (opts?.minPrice !== undefined && opts.minPrice > 0) {
    query = query.gte("price", opts.minPrice);
  }
  if (opts?.maxPrice !== undefined && opts.maxPrice < Infinity) {
    query = query.lte("price", opts.maxPrice);
  }
  if (opts?.savedOnly && opts.savedOnly.length > 0) {
    query = query.in("id", opts.savedOnly);
  }

  if (opts?.sort === "price_asc") {
    query = query.order("price", { ascending: true });
  } else if (opts?.sort === "price_desc") {
    query = query.order("price", { ascending: false });
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Listing[];
}

export async function fetchListing(id: string) {
  const { data, error } = await supabase
    .from("listings")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as Listing;
}

export async function incrementViewCount(listingId: string): Promise<void> {
  await supabase.rpc("increment_view_count", { listing_id: listingId });
}

export async function fetchUserListings(userId: string) {
  const { data, error } = await supabase
    .from("listings")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Listing[];
}

export async function deleteListing(id: string) {
  const { error } = await supabase.from("listings").delete().eq("id", id);
  if (error) throw error;
}

export async function updateListing(id: string, fields: Partial<Listing>) {
  const { error } = await supabase
    .from("listings")
    .update(fields)
    .eq("id", id);
  if (error) throw error;
}

export async function deleteConversation(conversationId: string, userId: string, buyerId: string): Promise<void> {
  const field = userId === buyerId ? "deleted_by_buyer" : "deleted_by_seller";
  const { error } = await supabase
    .from("conversations")
    .update({ [field]: true })
    .eq("id", conversationId);
  if (error) throw error;
}

// ── Conversations ──────────────────────────────────────────────────────────────

export async function fetchConversations(
  userId: string,
): Promise<ConversationWithPreview[]> {
  const { data: convos, error } = await supabase
    .from("conversations")
    .select("*, listings(title, price, images)")
    .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
    .order("updated_at", { ascending: false });

  if (error) throw error;
  if (!convos || convos.length === 0) return [];

  const convoIds = convos.map((c: any) => c.id);

  const { data: allMessages, error: msgError } = await supabase
    .from("messages")
    .select("*")
    .in("conversation_id", convoIds)
    .order("created_at", { ascending: false });

  if (msgError) throw msgError;

  const { data: unreadData, error: unreadError } = await supabase
    .from("messages")
    .select("conversation_id")
    .in("conversation_id", convoIds)
    .neq("sender_id", userId)
    .eq("read", false);

  if (unreadError) throw unreadError;

  const unreadMap: Record<string, number> = {};
  for (const msg of unreadData ?? []) {
    unreadMap[msg.conversation_id] = (unreadMap[msg.conversation_id] || 0) + 1;
  }

  const otherUserIds = convos.map((c: any) =>
    c.buyer_id === userId ? c.seller_id : c.buyer_id,
  );
  const uniqueUserIds = [...new Set(otherUserIds)];
  const userNames = await fetchUserNames(uniqueUserIds);

  const lastMessageMap: Record<string, any> = {};
  for (const msg of allMessages ?? []) {
    if (!lastMessageMap[msg.conversation_id]) {
      lastMessageMap[msg.conversation_id] = msg;
    }
  }

  const visibleConvos = convos.filter((c: any) =>
    c.buyer_id === userId ? !c.deleted_by_buyer : !c.deleted_by_seller
  );

  return visibleConvos.map((c: any) => {
    const otherId = c.buyer_id === userId ? c.seller_id : c.buyer_id;
    const otherName = userNames[otherId] || "Unknown";
    const initials = otherName.split(" ").map((w: string) => w[0]).join("").toUpperCase().slice(0, 2);
    const lastMsg = lastMessageMap[c.id];
    const listing = c.listings;

    return {
      id: c.id,
      listing_id: c.listing_id,
      buyer_id: c.buyer_id,
      seller_id: c.seller_id,
      created_at: c.created_at,
      updated_at: c.updated_at,
      other_name: otherName,
      other_initials: initials,
      last_message: lastMsg?.content ?? "",
      last_message_time: lastMsg?.created_at ?? c.created_at,
      unread_count: unreadMap[c.id] || 0,
      listing_title: listing?.title,
      listing_price: listing?.price,
      listing_images: listing?.images,
    } as ConversationWithPreview;
  });
}

export async function fetchOrCreateConversation(
  listingId: string | null,
  buyerId: string,
  sellerId: string,
): Promise<Conversation> {
  // Search both role orderings so we never create a duplicate
  let query = supabase
    .from("conversations")
    .select("*")
    .or(
      `and(buyer_id.eq.${buyerId},seller_id.eq.${sellerId}),and(buyer_id.eq.${sellerId},seller_id.eq.${buyerId})`,
    );

  if (listingId) {
    query = query.eq("listing_id", listingId);
  } else {
    query = query.is("listing_id", null);
  }

  const { data: rows, error: findError } = await query.limit(1);
  if (findError) throw findError;
  if (rows && rows.length > 0) {
    const existing = rows[0] as Conversation;
    // Reset deleted flags so both users can see the conversation again
    await supabase
      .from("conversations")
      .update({ deleted_by_buyer: false, deleted_by_seller: false })
      .eq("id", existing.id);
    return existing;
  }

  const { data: created, error: createError } = await supabase
    .from("conversations")
    .insert({ listing_id: listingId, buyer_id: buyerId, seller_id: sellerId })
    .select()
    .single();

  if (createError) throw createError;
  return created as Conversation;
}

export async function fetchMessages(conversationId: string): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return (data ?? []) as Message[];
}

export async function sendMessage(
  conversationId: string,
  senderId: string,
  content: string,
): Promise<Message> {
  const { data, error } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: senderId, content })
    .select()
    .single();

  if (error) throw error;

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString(), deleted_by_buyer: false, deleted_by_seller: false })
    .eq("id", conversationId);

  return data as Message;
}

export async function deleteMessage(messageId: string): Promise<void> {
  const { error } = await supabase.from("messages").delete().eq("id", messageId);
  if (error) throw error;
}

export async function markMessagesRead(conversationId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from("messages")
    .update({ read: true })
    .eq("conversation_id", conversationId)
    .neq("sender_id", userId)
    .eq("read", false);

  if (error) throw error;
}

export async function getUnreadCount(userId: string): Promise<number> {
  const { data: convos, error: convoError } = await supabase
    .from("conversations")
    .select("id, buyer_id, deleted_by_buyer, deleted_by_seller")
    .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`);

  if (convoError) throw convoError;
  if (!convos || convos.length === 0) return 0;

  const visibleConvos = convos.filter((c: any) =>
    c.buyer_id === userId ? !c.deleted_by_buyer : !c.deleted_by_seller
  );
  if (visibleConvos.length === 0) return 0;

  const convoIds = visibleConvos.map((c: any) => c.id);

  const { count, error } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .in("conversation_id", convoIds)
    .neq("sender_id", userId)
    .eq("read", false);

  if (error) throw error;
  return count ?? 0;
}

// ── Reports ────────────────────────────────────────────────────────────────────

export async function submitReport(
  listingId: string,
  reporterId: string,
  reason: string,
  details?: string,
): Promise<Report> {
  const { data, error } = await supabase
    .from("reports")
    .insert({ listing_id: listingId, reporter_id: reporterId, reason, details: details || null })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") throw new Error("You have already reported this listing.");
    throw error;
  }
  return data as Report;
}

export async function hasReported(listingId: string, reporterId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from("reports")
    .select("*", { count: "exact", head: true })
    .eq("listing_id", listingId)
    .eq("reporter_id", reporterId);

  if (error) throw error;
  return (count ?? 0) > 0;
}

// ── Reviews ────────────────────────────────────────────────────────────────────

export async function submitReview(
  listingId: string,
  reviewerId: string,
  reviewedUserId: string,
  sellerId: string,
  rating: number,
  reviewType: "buyer_to_seller" | "seller_to_buyer",
  reviewerName: string,
  comment?: string,
): Promise<Review> {
  const { data, error } = await supabase
    .from("reviews")
    .insert({
      listing_id: listingId,
      reviewer_id: reviewerId,
      seller_id: sellerId,
      reviewed_user_id: reviewedUserId,
      review_type: reviewType,
      reviewer_name: reviewerName,
      rating: Math.min(5, Math.max(1, Math.round(rating))),
      comment: comment || null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") throw new Error("You have already reviewed this listing.");
    throw error;
  }
  return data as Review;
}

export async function fetchSellerReviews(sellerId: string): Promise<Review[]> {
  const { data, error } = await supabase
    .from("reviews")
    .select("*")
    .eq("reviewed_user_id", sellerId)
    .eq("review_type", "buyer_to_seller")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as Review[];
}

export async function fetchUserReviews(userId: string): Promise<Review[]> {
  const { data, error } = await supabase
    .from("reviews")
    .select("*")
    .eq("reviewed_user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as Review[];
}

export async function fetchReviewsByUser(userId: string): Promise<Review[]> {
  const { data, error } = await supabase
    .from("reviews")
    .select("*")
    .eq("reviewer_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as Review[];
}

export async function fetchListingReviews(listingId: string): Promise<Review[]> {
  const { data, error } = await supabase
    .from("reviews")
    .select("*")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as Review[];
}

export async function fetchSellerRating(sellerId: string): Promise<SellerRating> {
  const { data, error } = await supabase
    .from("reviews")
    .select("rating")
    .eq("reviewed_user_id", sellerId)
    .eq("review_type", "buyer_to_seller");

  if (error) throw error;

  const reviews = data ?? [];
  if (reviews.length === 0) return { average: 0, count: 0 };

  const sum = reviews.reduce((acc: number, r: any) => acc + r.rating, 0);
  return { average: Math.round((sum / reviews.length) * 10) / 10, count: reviews.length };
}

export async function fetchUserRating(userId: string): Promise<UserRating> {
  const { data, error } = await supabase
    .from("reviews")
    .select("rating, review_type")
    .eq("reviewed_user_id", userId);

  if (error) throw error;

  const all = data ?? [];
  if (all.length === 0) {
    return { average: 0, count: 0, asSeller: { average: 0, count: 0 }, asBuyer: { average: 0, count: 0 } };
  }

  const sellerReviews = all.filter((r: any) => r.review_type === "buyer_to_seller");
  const buyerReviews = all.filter((r: any) => r.review_type === "seller_to_buyer");

  function average(arr: any[]) {
    if (arr.length === 0) return { average: 0, count: 0 };
    const sum = arr.reduce((acc: number, r: any) => acc + r.rating, 0);
    return { average: Math.round((sum / arr.length) * 10) / 10, count: arr.length };
  }

  const overall = average(all);
  return { ...overall, asSeller: average(sellerReviews), asBuyer: average(buyerReviews) };
}

export async function hasReviewed(listingId: string, reviewerId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from("reviews")
    .select("*", { count: "exact", head: true })
    .eq("listing_id", listingId)
    .eq("reviewer_id", reviewerId);

  if (error) throw error;
  return (count ?? 0) > 0;
}

// ── Transactions ──────────────────────────────────────────────────────────────

export async function fetchUserTransactions(userId: string): Promise<TransactionWithNames[]> {
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .or(`seller_id.eq.${userId}, buyer_id.eq.${userId}`)
    .order("completed_at", { ascending: false });

  if (error) throw error;
  if (!data || data.length === 0) return [];

  const userIds = new Set<string>();
  for (const t of data) {
    userIds.add(t.seller_id);
    if (t.buyer_id) userIds.add(t.buyer_id);
  }

  const names = await fetchUserNames([...userIds]);

  return data.map((t: any) => ({
    ...t,
    seller_name: names[t.seller_id] || "Unknown",
    buyer_name: t.buyer_id ? names[t.buyer_id] || "Unknown" : null,
  })) as TransactionWithNames[];
}

export async function createTransaction(fields: {
  listing_id: string;
  seller_id: string;
  buyer_id?: string | null;
  price: number;
  title: string;
  category?: string;
  images?: string[];
}): Promise<Transaction> {
  const { data, error } = await supabase.from("transactions").insert(fields).select().single();
  if (error) throw error;
  return data as Transaction;
}

export async function cancelTransaction(transactionId: string) {
  const { error } = await supabase.from("transactions").update({ status: "cancelled" }).eq("id", transactionId);
  if (error) throw error;
}

export async function assignTransactionBuyer(transactionId: string, buyerId: string) {
  const { error } = await supabase.from("transactions").update({ buyer_id: buyerId }).eq("id", transactionId);
  if (error) throw error;
}

// ── Notifications ──────────────────────────────────────────────────────────────

export async function fetchNotifications(
  userId: string,
  opts?: { unreadOnly?: boolean; limit?: number }
): Promise<Notification[]> {
  let query = supabase
    .from("notifications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (opts?.unreadOnly) query = query.eq("read", false);
  if (opts?.limit) query = query.limit(opts.limit);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Notification[];
}

export async function getUnreadNotifications(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("read", false);
  if (error) throw error;
  return count ?? 0;
}

export async function markNotificationRead(notificationId: string) {
  const { error } = await supabase.from("notifications").update({ read: true }).eq("id", notificationId);
  if (error) throw error;
}

export async function markAllNotificationsRead(userId: string) {
  const { error } = await supabase.from("notifications").update({ read: true }).eq("user_id", userId).eq("read", false);
  if (error) throw error;
}

export async function deleteNotification(notificationId: string) {
  const { error } = await supabase.from("notifications").delete().eq("id", notificationId);
  if (error) throw error;
}

export async function clearReadNotifications(userId: string) {
  const { error } = await supabase.from("notifications").delete().eq("user_id", userId).eq("read", true);
  if (error) throw error;
}

// ── Sale Reminders ─────────────────────────────────────────────────────────────

export async function checkStaleListingsAndNotify(userId: string): Promise<void> {
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  const { data: staleListings } = await supabase
    .from("listings")
    .select("id, title, price")
    .eq("user_id", userId)
    .eq("status", "available")
    .eq("on_sale", false)
    .is("sale_notified_at", null)
    .lt("created_at", fourteenDaysAgo.toISOString());

  if (!staleListings || staleListings.length === 0) return;

  for (const listing of staleListings) {
    await supabase.from("notifications").insert({
      user_id: userId,
      type: "sale_reminder",
      title: "Consider putting your item on sale",
      body: `"${listing.title}" has been unsold for 2 weeks. Adding a discount could help it sell faster!`,
      link: `/post?edit=${listing.id}`,
      read: false,
    });

    await supabase.from("listings").update({ sale_notified_at: new Date().toISOString() }).eq("id", listing.id);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export async function fetchUserNames(userIds: string[]): Promise<Record<string, string>> {
  const nameMap: Record<string, string> = {};
  if (userIds.length === 0) return nameMap;

  const { data: profiles, error: profileError } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in("id", userIds);

  if (!profileError && profiles) {
    for (const profile of profiles) {
      if (profile.full_name) nameMap[profile.id] = profile.full_name;
    }
  }

  const missing = userIds.filter((id) => !nameMap[id]);
  if (missing.length > 0) {
    const { data: listings } = await supabase
      .from("listings")
      .select("user_id, seller_name")
      .in("user_id", userIds)
      .not("seller_name", "is", null);

    for (const row of listings ?? []) {
      if (row.seller_name && !nameMap[row.user_id]) nameMap[row.user_id] = row.seller_name;
    }
  }

  return nameMap;
}

export function timeAgo(dateString: string): string {
  const now = Date.now();
  const date = new Date(dateString).getTime();
  const difference = now - date;
  const minutes = Math.floor(difference / 60000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const BUCKET = "listing-images";

export async function uploadListingImage(file: File, userId: string): Promise<string> {
  const ext = file.name.split(".").pop();
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (error) throw error;

  const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return publicUrl;
}

export async function deleteListingImages(urls: string[]): Promise<void> {
  const paths = urls
    .map((url) => {
      const marker = `/object/public/${BUCKET}/`;
      const idx = url.indexOf(marker);
      return idx !== -1 ? url.slice(idx + marker.length) : null;
    })
    .filter(Boolean) as string[];

  if (paths.length === 0) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) throw error;
}

// ── Saved Listings ─────────────────────────────────────────────────────────────

export async function fetchSavedListingIds(userId: string): Promise<string[]> {
  const { data, error } = await supabase.from("saved_listings").select("listing_id").eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((row: any) => row.listing_id);
}

export async function toggleSaveListing(userId: string, listingId: string): Promise<boolean> {
  const { data: existing, error: checkError } = await supabase
    .from("saved_listings")
    .select("id")
    .eq("user_id", userId)
    .eq("listing_id", listingId)
    .maybeSingle();

  if (checkError) throw checkError;

  if (existing) {
    const { error } = await supabase.from("saved_listings").delete().eq("user_id", userId).eq("listing_id", listingId);
    if (error) throw error;
    return false;
  } else {
    const { error } = await supabase.from("saved_listings").insert({ user_id: userId, listing_id: listingId });
    if (error) throw error;
    return true;
  }
}

// ── Admin / Moderation ────────────────────────────────────────────────────────

export interface ReportWithDetails extends Report {
  listing_title: string;
  listing_images: string[];
  listing_status: string;
  reporter_name: string;
  seller_name: string | null;
}

export async function checkIsAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase.from("profiles").select("is_admin").eq("id", userId).single();
  if (error) return false;
  return data?.is_admin === true;
}

export async function fetchAllReports(statusFilter?: string): Promise<ReportWithDetails[]> {
  let query = supabase
    .from("reports")
    .select("*, listings(title, images, status, seller_name, user_id)")
    .order("created_at", { ascending: false });

  if (statusFilter && statusFilter !== "all") {
    query = query.eq("status", statusFilter);
  }

  const { data, error } = await query;
  if (error) throw error;

  const reporterIds = [...new Set((data ?? []).map((r: any) => r.reporter_id))];
  const names = await fetchUserNames(reporterIds);

  return (data ?? []).map((r: any) => ({
    id: r.id,
    listing_id: r.listing_id,
    reporter_id: r.reporter_id,
    reason: r.reason,
    details: r.details,
    status: r.status,
    created_at: r.created_at,
    listing_title: r.listings?.title ?? "Deleted listing",
    listing_images: r.listings?.images ?? [],
    listing_status: r.listings?.status ?? "unknown",
    seller_name: r.listings?.seller_name ?? null,
    reporter_name: names[r.reporter_id] ?? "Unknown",
  })) as ReportWithDetails[];
}

export async function updateReportStatus(reportId: string, status: "resolved" | "dismissed"): Promise<void> {
  const { error } = await supabase.from("reports").update({ status }).eq("id", reportId);
  if (error) throw error;
}

export async function adminDeleteListing(id: string): Promise<void> {
  const { error } = await supabase.from("listings").delete().eq("id", id);
  if (error) throw error;
}

// ── Seller Dashboard / Listing Insights ───────────────────────────────────────

export interface ListingInsight extends Listing {
  save_count: number;
  conversation_count: number;
  days_active: number;
  suggestion: string;
}

export async function fetchSellerDashboard(userId: string): Promise<ListingInsight[]> {
  const { data: listings, error } = await supabase
    .from("listings")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  if (!listings || listings.length === 0) return [];

  const listingIds = listings.map((l: any) => l.id);

  const { data: saves } = await supabase
    .from("saved_listings")
    .select("listing_id")
    .in("listing_id", listingIds);

  const saveMap: Record<string, number> = {};
  for (const s of saves ?? []) saveMap[s.listing_id] = (saveMap[s.listing_id] || 0) + 1;

  const { data: convos } = await supabase
    .from("conversations")
    .select("listing_id")
    .in("listing_id", listingIds);

  const convoMap: Record<string, number> = {};
  for (const c of convos ?? []) convoMap[c.listing_id] = (convoMap[c.listing_id] || 0) + 1;

  return listings.map((l: any) => {
    const saves = saveMap[l.id] || 0;
    const convos = convoMap[l.id] || 0;
    const views = l.view_count || 0;
    const daysActive = Math.floor((Date.now() - new Date(l.created_at).getTime()) / 86400000);

    let suggestion = "";
    if (l.status === "sold") {
      suggestion = "Sold! Great job.";
    } else if (views > 30 && saves > 3 && convos === 0) {
      suggestion = "High interest but no messages — consider lowering the price slightly.";
    } else if (daysActive > 30 && l.status === "available" && !l.on_sale) {
      suggestion = "Listed 30+ days. Try adding a discount to boost visibility.";
    } else if (views > 15 && saves === 0) {
      suggestion = "People are viewing but not saving — try better photos or a clearer title.";
    } else if (views < 5 && daysActive > 7) {
      suggestion = "Low views after a week — try updating your title or description.";
    } else if (daysActive < 3) {
      suggestion = "Just listed! Give it a few days to get traction.";
    } else {
      suggestion = "Your listing is live and getting attention!";
    }

    return { ...l, save_count: saves, conversation_count: convos, days_active: daysActive, suggestion } as ListingInsight;
  });
}

// ── Trade / Swap Offers ───────────────────────────────────────────────────────

export async function createTradeOffer(listingId: string, offererId: string, offeredListingId: string): Promise<TradeOffer> {
  const { data, error } = await supabase
    .from("trade_offers")
    .insert({ listing_id: listingId, offerer_id: offererId, offered_listing_id: offeredListingId })
    .select()
    .single();
  if (error) throw error;
  return data as TradeOffer;
}

export async function fetchTradeOffersForListing(listingId: string): Promise<TradeOffer[]> {
  const { data, error } = await supabase
    .from("trade_offers")
    .select("*")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as TradeOffer[];
}

export async function fetchMyTradeOffers(userId: string): Promise<TradeOffer[]> {
  const { data, error } = await supabase
    .from("trade_offers")
    .select("*")
    .eq("offerer_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as TradeOffer[];
}

export async function updateTradeOfferStatus(offerId: string, status: "accepted" | "declined" | "cancelled"): Promise<void> {
  const { error } = await supabase.from("trade_offers").update({ status }).eq("id", offerId);
  if (error) throw error;
}

// ── Campus Meetup Scheduler ───────────────────────────────────────────────────

export const CAMPUS_LOCATIONS = [
  "Campus Center",
  "Campus Commons",
  "Greenley Hall (Library)",
  "Laffin Hall – Student Services Center",
  "Gleeson Plaza",
  "Ralph Bunche Plaza",
  "Amphitheater",
  "School of Business",
  "Memorial Hall",
  "Hooper Hall",
  "Roosevelt Hall",
  "Hicks Hall",
] as const;

export async function proposeMeetup(
  conversationId: string,
  proposerId: string,
  otherUserId: string,
  listingId: string | null,
  location: string,
  proposedTime: string,
): Promise<Meetup> {
  const { data, error } = await supabase
    .from("meetups")
    .insert({ conversation_id: conversationId, proposer_id: proposerId, other_user_id: otherUserId, listing_id: listingId, location, proposed_time: proposedTime })
    .select()
    .single();
  if (error) throw error;
  return data as Meetup;
}

export async function fetchMeetupForConversation(conversationId: string): Promise<Meetup | null> {
  const { data, error } = await supabase
    .from("meetups")
    .select("*")
    .eq("conversation_id", conversationId)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as Meetup | null;
}

export async function updateMeetupStatus(meetupId: string, status: "confirmed" | "cancelled"): Promise<void> {
  const { error } = await supabase.from("meetups").update({ status }).eq("id", meetupId);
  if (error) throw error;
}

export async function fetchAllListings(): Promise<Listing[]> {
  const { data, error } = await supabase.from("listings").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Listing[];
}

export async function fetchAllProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Profile[];
}

// ── Bids (Auctions) ───────────────────────────────────────────────────────────

export interface Bid {
  id: string;
  listing_id: string;
  bidder_id: string;
  bidder_name: string;
  amount: number;
  created_at: string;
}

export async function fetchBids(listingId: string): Promise<Bid[]> {
  const { data, error } = await supabase
    .from("bids")
    .select("*")
    .eq("listing_id", listingId)
    .order("amount", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Bid[];
}

export async function placeBid(
  listingId: string,
  bidderId: string,
  bidderName: string,
  amount: number,
): Promise<Bid> {
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("status, auction_end_time, title, user_id")
    .eq("id", listingId)
    .single();
  if (listingError) throw listingError;
  if (listing.status === "sold" || (listing.auction_end_time && new Date(listing.auction_end_time) <= new Date())) {
    throw new Error("This auction has ended.");
  }

  // Capture current highest bidder before inserting
  const { data: topBids } = await supabase
    .from("bids")
    .select("bidder_id, bidder_name, amount")
    .eq("listing_id", listingId)
    .order("amount", { ascending: false })
    .limit(1);
  const previousHighest = topBids?.[0] ?? null;

  const { data, error } = await supabase
    .from("bids")
    .insert({ listing_id: listingId, bidder_id: bidderId, bidder_name: bidderName, amount })
    .select()
    .single();
  if (error) throw error;

  // Notify previous highest bidder they've been outbid
  if (previousHighest && previousHighest.bidder_id !== bidderId) {
    await supabase.from("notifications").insert({
      user_id: previousHighest.bidder_id,
      type: "outbid",
      title: "You've been outbid!",
      body: `Someone bid $${amount.toFixed(2)} on "${listing.title}". Place a higher bid to stay in the lead.`,
      link: `/item?id=${listingId}`,
      read: false,
    });
  }

  // Notify the seller of the new bid
  if (listing.user_id !== bidderId) {
    await supabase.from("notifications").insert({
      user_id: listing.user_id,
      type: "new_bid",
      title: "New bid on your auction!",
      body: `${bidderName} placed a bid of $${amount.toFixed(2)} on "${listing.title}".`,
      link: `/item?id=${listingId}`,
      read: false,
    });
  }

  return data as Bid;
}