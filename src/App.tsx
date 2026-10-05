import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  Home,
  Compass,
  Clock3,
  Clock,
  UserRound,
  Sparkles,
  Star,
  Heart,
  Plus,
  SlidersHorizontal,
  Send,
  ChevronRight,
  MapPin,
  Coffee,
  BusFront,
  CarFront,
  Footprints,
  Share2,
  Download,
  X,
  Pencil,
  Trash2,
  LoaderCircle,
  Check,
  LogOut,
  Globe2,
  ShieldCheck,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  Route,
  Link2,
  CircleAlert,
  Ticket,
} from "lucide-react";
import MapView from "./MapView";
import GlassSelect from "./GlassSelect";
import GlassTimePicker from "./GlassTimePicker";
import { PhotoGallery, BookingChannels, ContentNotice } from "./PlaceDetails";
import { MotionPresence, MotionTabs, reducedMotion, useContentMotion, usePageMotion } from "./motion";
import { api, post, patch, streamChat, downloadFile, ApiError } from "./api";
import { copyText } from "./native";
import { newId } from "./uuid.mjs";
import { startAccountSync } from "./account-sync.mjs";
import { limitCharacters, USERNAME_MAX_LENGTH, PASSWORD_MAX_LENGTH, USERNAME_PATTERN } from "../shared/account-rules.mjs";
import { cachedPlaceContent, loadPlaceContent, rememberPlaceContent, subscribePlaceContent, warmBundle, warmPlace } from "./place-preload";
import {
  IconButton,
  Modal,
  Back,
  Photo,
  PlaceCard,
  PlannerInput,
  Empty,
  Row,
} from "./components";
import type {
  Place,
  Trip,
  User,
  Preferences,
  Message,
  Audit,
  TripBundle,
  TripFile,
  Item,
  Conversation,
  PlaceContentStatus,
  PlaceContentMetadata,
} from "./types";
type ModalState = {
  type:
    | "auth"
    | "delete-account"
    | "preferences"
    | "add"
    | "edit"
    | "new"
    | "share"
    | "favorites"
    | "shares"
    | "choose";
  place?: Place;
  item?: Item;
  day?: number;
};
type DeleteTarget = { kind: "trip" | "draft"; id: string; title: string; scope?: "saved" | "footprint" };
const paceText = {
  relaxed: "轻松慢游",
  balanced: "充实游览",
  packed: "充实行程",
};
const transportText = { auto: "智能选择（可自驾）", walking: "步行", driving: "驾车", transit: "公共交通" };
const icons = { auto: CarFront, walking: Footprints, driving: CarFront, transit: BusFront };
function pathInfo() {
  return decodeURI(window.location.pathname);
}
function duration(minutes: number) {
  return minutes >= 60
    ? `${Number((minutes / 60).toFixed(1))}h`
    : `${minutes}分钟`;
}
function shortDate(date: string) {
  return new Date(date).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  });
}
function nextTime(items: Item[]) {
  const last = items[items.length - 1];
  if (!last) return "09:30";
  const [h, m] = last.arrival.split(":").map(Number);
  const n = Math.min(23 * 60, h * 60 + m + last.durationMinutes + 45);
  return `${Math.floor(n / 60)
    .toString()
    .padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}`;
}
export default function App() {
  const [path, setPath] = useState(pathInfo);
  const [user, setUser] = useState<User | null>(null);
  const pendingAI = useRef<{ text: string; adjust: boolean } | "revise" | null>(null);
  const [featured, setFeatured] = useState<Place[]>([]);
  const [places, setPlaces] = useState<Record<string, Place>>({});
  const [favorites, setFavorites] = useState<string[]>([]);
  const [demo, setDemo] = useState<TripBundle | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [request, setRequest] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [chatError, setChatError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [audit, setAudit] = useState<Audit | null>(null);
  const [day, setDay] = useState(1);
  const [sheetExpanded, updateSheetExpanded] = useState(true);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [authRegister, setAuthRegister] = useState(false);
  useEffect(() => { if (modal?.type !== "auth") setAuthRegister(false); }, [modal?.type]);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteMode, setDeleteMode] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [toast, setToast] = useState("");
  const [detail, setDetail] = useState<{
    place: Place;
    reviews: any[];
    rating: number | null;
    content?: PlaceContentMetadata | null;
  } | null>(null);
  const [detailTab, setDetailTab] = useState("overview");
  const [contentStatus, setContentStatus] = useState<PlaceContentStatus>("local");
  const [contentRetry, setContentRetry] = useState(0);
  const handledContentRetry = useRef(0);
  const placesRef = useRef(places);
  const detailRef = useRef(detail);
  const pathRef = useRef(path);
  placesRef.current = places;
  detailRef.current = detail;
  pathRef.current = path;
  const [stats, setStats] = useState({ trips: 0, favorites: 0, visited: 0 });
  const [filter, setFilter] = useState("saved");
  const [shared, setShared] = useState<TripFile | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [favoritePlaces, setFavoritePlaces] = useState<Place[]>([]);
  const [sharePath, setSharePath] = useState("");
  const [myShares, setMyShares] = useState<any[]>([]);
  const [working, setWorking] = useState(false);
  const syncState = useRef({ trip, conversationId, busy, working, deleting, modal, deleteTarget });
  syncState.current = { trip, conversationId, busy, working, deleting, modal, deleteTarget };
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const messageEnd = useRef<HTMLDivElement>(null);
  const detailOrigin = useRef("/home");
  const fileInput = useRef<HTMLInputElement>(null);
  const dragStart = useRef<number | null>(null);
  const dragHandled = useRef(false);
  const chatNearBottom = useRef(true);
  const dayScroll = useRef<Record<string, number>>({});
  const timeline = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLElement>(null);
  const changePage = usePageMotion(surface);
  const navigationIndex = useRef<number>(window.history.state?.roamlyIndex || 0);
  const setSheetExpanded = (next: boolean | ((value: boolean) => boolean)) => {
    // Capture before the footer and sheet change size and clamp scrollTop.
    if (timeline.current)
      dayScroll.current[`${trip?.id}:${day}`] = timeline.current.scrollTop;
    updateSheetExpanded(next);
  };
  const pageScroll = useRef<Record<string, number>>({});
  const notify = (s: string) => setToast(s);
  const addPlaces = (newPlaces: Place[]) =>
    setPlaces((old) => ({
      ...old,
      ...Object.fromEntries(newPlaces.map((p) => [p.id, cachedPlaceContent(p.id)?.place || p])),
    }));
  const selectMapPlace = (place: Place) => {
    addPlaces([place]);
    warmPlace(place);
    setFocused(place.id);
  };
  const navigate = (target: string) => {
    if (target === decodeURI(window.location.pathname)) return;
    if (scroll.current) pageScroll.current[path] = scroll.current.scrollTop;
    if (timeline.current)
      dayScroll.current[`${trip?.id}:${day}`] = timeline.current.scrollTop;
    window.history.pushState({ roamlyIndex: ++navigationIndex.current }, "", target);
    const primary = ["/home", "/explore", "/trips", "/me"].includes(target);
    const backward = path.startsWith("/destination/") ||
      (path.startsWith("/itinerary/") && primary);
    changePage(() => {
      setPath(target);
      setLoadError("");
    }, primary, backward ? -1 : 1);
  };
  useEffect(() => {
    window.history.replaceState({ ...window.history.state, roamlyIndex: navigationIndex.current }, "");
    const listener = (event: PopStateEvent) => {
      const next = event.state?.roamlyIndex ?? navigationIndex.current - 1;
      const direction = Math.sign(next - navigationIndex.current) || -1;
      navigationIndex.current = next;
      changePage(() => {
        setPath(pathInfo());
        setLoadError("");
      }, false, direction);
    };
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, [changePage]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => setDeleteMode(false), [path]);
  useEffect(() => {
    if (!deleteMode || deleteTarget || path !== "/trips") return;
    const cancelOnBlank = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("button, a, input, textarea, select, dialog, [role='button'], .saved-trip-card, .draft-card")) return;
      setDeleteMode(false);
    };
    document.addEventListener("click", cancelOnBlank);
    return () => document.removeEventListener("click", cancelOnBlank);
  }, [deleteMode, deleteTarget, path]);
  const reloadTrips = async () => {
    const [t, c] = await Promise.all([
      api<Trip[]>("/trips"),
      api<Conversation[]>("/conversations"),
    ]);
    setTrips(t);
    setConversations(c);
    return t;
  };
  const requestDelete = (target: DeleteTarget) => {
    setDeleteError("");
    setDeleteTarget(target);
  };
  const deleteSaved = async () => {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    setDeleting(true);
    setDeleteError("");
    try {
      const result = await api<{ removed?: boolean; trip?: Trip }>(`/${target.kind === "trip" ? "trips" : "conversations"}/${target.id}${target.scope ? `?scope=${target.scope}` : ""}`, { method: "DELETE" });
      if (target.kind === "trip" && result.trip && result.removed === false) {
        const retained = result.trip;
        setTrips((old) => old.map((t) => t.id === retained.id ? { ...t, ...retained } : t));
        if (trip?.id === retained.id) setTrip(retained);
        setDeleteTarget(null);
        notify(target.scope === "footprint" ? "已从旅行足迹移除" : "已从全部行程移除");
        return;
      }
      const removedConversations = conversations.filter((c) =>
        target.kind === "trip" ? c.trip_id === target.id : c.id === target.id,
      );
      setConversations((old) => old.filter((c) =>
        target.kind === "trip" ? c.trip_id !== target.id : c.id !== target.id,
      ));
      if (target.kind === "trip") {
        setTrips((old) => old.filter((t) => t.id !== target.id));
        setMyShares((old) => old.filter((s) => s.trip_id !== target.id));
        if (trip?.id === target.id) {
          setTrip(null);
          setAudit(null);
          setFocused(null);
        }
      }
      if (removedConversations.some((c) => c.id === conversationId)) {
        setConversationId(undefined);
        setMessages([]);
        setChatInput("");
        setChatError("");
      }
      setDeleteTarget(null);
      notify(target.kind === "trip" ? (target.scope === "footprint" ? "已从旅行足迹移除" : "行程已删除") : "草稿已删除");
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };
  const loadProfile = async () => {
    const d = await api<{ user: User; stats: typeof stats }>("/profile");
    setUser(d.user);
    setStats(d.stats);
  };
  const bootstrap = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const b = await api<{
        user: User;
        featured: Place[];
        favorites: string[];
        demo: TripBundle;
      }>("/bootstrap");
      setUser(b.user);
      setFeatured(b.featured);
      setFavorites(b.favorites);
      setDemo(b.demo);
      addPlaces([...b.featured, ...b.demo.places]);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    bootstrap();
    return () => abort.current?.abort();
  }, []);
  useEffect(() => subscribePlaceContent((result) => {
    setPlaces((old) => old[result.place.id] === result.place ? old : { ...old, [result.place.id]: result.place });
    if (pathRef.current.startsWith("/destination/") && detailRef.current?.place.id === result.place.id) {
      setContentStatus(result.status);
      setDetail((current) => current?.place.id === result.place.id ? { ...current, place: result.place, content: result } : current);
    }
  }), []);
  const useBundle = (bundle: TripBundle) => {
    warmBundle(bundle);
    setTrip(bundle.trip);
    addPlaces(bundle.places);
    setAudit(bundle.audit || null);
    setDay(1);
    setSheetExpanded(true);
  };
  useEffect(() => {
    if (!user) return;
    let active = true;
    const load = async () => {
      try {
        if (path === "/trips") {
          await reloadTrips();
        } else if (path === "/me") {
          await loadProfile();
        } else if (path.startsWith("/itinerary/")) {
          const id = path.split("/")[2];
          if (id === "demo" && demo) {
            useBundle(demo);
            setDay(2);
          } else if (id !== trip?.id) {
            const b = await api<TripBundle>(`/trips/${id}`);
            if (active) useBundle(b);
          }
        } else if (path.startsWith("/destination/")) {
          const id = decodeURIComponent(path.split("/")[2]);
          const warmed = cachedPlaceContent(id);
          const knownPlace = warmed?.place || placesRef.current[id];
          setDetail(knownPlace ? { place: knownPlace, reviews: [], rating: null, content: warmed } : null);
          setDetailTab("overview");
          setContentStatus(warmed?.status || (/^amap-/.test(id) ? "loading" : "local"));
          setContentRetry(0);
          const d = await api<typeof detail>(
            `/places/${encodeURIComponent(path.split("/")[2])}`,
          );
          if (active && d) {
            if (d.content) rememberPlaceContent({ ...d.content, place: d.place });
            const ready = cachedPlaceContent(d.place.id);
            setDetail({ ...d, place: ready?.place || d.place });
            if (ready) setContentStatus(ready.status);
            addPlaces([d.place]);
          }
        } else if (path.startsWith("/share/")) {
          const f = await api<TripFile>(
            `/shares/${encodeURIComponent(path.split("/")[2])}`,
          );
          if (active) {
            setShared(f);
            useBundle({ trip: f.itinerary, places: f.places, audit: f.audit });
          }
        } else if (path.startsWith("/ai/chat/") && !busy) {
          const id = path.split("/")[3];
          if (id !== "new" && id !== conversationId) {
            const list = await api<Conversation[]>("/conversations");
            const c = list.find((c) => c.id === id);
            if (c && active) {
              setConversationId(c.id);
              setMessages(c.messages);
              if (c.trip_id) {
                const b = await api<TripBundle>(`/trips/${c.trip_id}`);
                useBundle(b);
              }
            }
          }
        }
      } catch (e) {
        if (active) setLoadError((e as Error).message);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [path, user?.id, demo]);
  useEffect(() => {
    if (!user?.username || busy || working || deleting || modal || deleteTarget) return;
    let active = true;
    const stop = startAccountSync({
      window,
      document,
      refresh: async (signal: AbortSignal) => {
        const snapshot = syncState.current;
        const valid = () => active && !signal.aborted && snapshot.trip === syncState.current.trip &&
          snapshot.conversationId === syncState.current.conversationId && !syncState.current.busy &&
          !syncState.current.working && !syncState.current.deleting && !syncState.current.modal && !syncState.current.deleteTarget;
        const [saved, drafts, profile, favoriteIds] = await Promise.all([
          api<Trip[]>("/trips", { signal, cache: "no-store" }),
          api<Conversation[]>("/conversations", { signal, cache: "no-store" }),
          api<{ user: User; stats: typeof stats }>("/profile", { signal, cache: "no-store" }),
          api<Place[]>("/favorites", { signal, cache: "no-store" }),
        ]);
        if (!valid() || profile.user.id !== user.id) return;
        // Shared snapshots and the design demo are not account-owned routes.
        const ownedTrip = snapshot.trip && snapshot.trip.id !== "demo" &&
          (path.startsWith("/itinerary/") || path.startsWith("/ai/chat/"));
        const remote = ownedTrip ? saved.find((t) => t.id === snapshot.trip!.id) : undefined;
        let bundle: TripBundle | undefined;
        if (remote) {
          if (remote.updatedAt !== snapshot.trip!.updatedAt || remote.favorite !== snapshot.trip!.favorite ||
              remote.status !== snapshot.trip!.status || remote.savedVisible !== snapshot.trip!.savedVisible ||
              remote.footprintVisible !== snapshot.trip!.footprintVisible) {
            bundle = await api<TripBundle>(`/trips/${remote.id}`, { signal, cache: "no-store" });
          }
        }
        if (!valid()) return;
        setTrips(saved);
        setConversations(drafts);
        setUser(profile.user);
        setStats(profile.stats);
        setFavorites(favoriteIds.map((p) => p.id));
        setFavoritePlaces(favoriteIds);
        addPlaces(favoriteIds);
        if (snapshot.conversationId) {
          const conversation = drafts.find((c) => c.id === snapshot.conversationId);
          if (conversation) setMessages(conversation.messages);
          else {
            setConversationId(undefined);
            setMessages([]);
            setChatInput("");
            setChatError("");
          }
        }
        if (ownedTrip && !remote) {
          setTrip(null);
          setAudit(null);
          setFocused(null);
          navigate("/trips");
          notify("此行程已在另一台设备删除");
        } else if (bundle) {
          warmBundle(bundle);
          addPlaces(bundle.places);
          setTrip(bundle.trip);
          setAudit(bundle.audit || null);
          setDay((current) => Math.min(current, bundle!.trip.days.length));
        }
      },
    });
    return () => { active = false; stop(); };
  }, [user?.id, user?.username, path, busy, working, deleting, modal, deleteTarget]);
  const detailId = detail?.place.id;
  useEffect(() => {
    if (!detailId || !path.startsWith("/destination/") || decodeURIComponent(path.split("/")[2]) !== detailId) return;
    let active = true;
    const force = contentRetry > 0 && contentRetry !== handledContentRetry.current;
    handledContentRetry.current = contentRetry;
    const warmed = force ? null : cachedPlaceContent(detailId);
    setContentStatus(warmed?.status || "loading");
    loadPlaceContent(detailId, { force })
      .then((result) => {
        if (!active) return;
        setDetail((current) => current?.place.id === detailId ? { ...current, place: result.place, content: result } : current);
        addPlaces([result.place]);
        setContentStatus(result.status);
      }).catch(() => { if (active) setContentStatus("error"); });
    return () => { active = false; };
  }, [detailId, contentRetry, path]);
  useEffect(() => {
    if (chatNearBottom.current)
      messageEnd.current?.scrollIntoView({ behavior: reducedMotion() ? "instant" : "smooth", block: "end" });
  }, [messages, progress]);
  useLayoutEffect(() => {
    if (timeline.current && sheetExpanded)
      timeline.current.scrollTop =
        dayScroll.current[`${trip?.id}:${day}`] || 0;
    if (scroll.current)
      scroll.current.scrollTop = pageScroll.current[path] || 0;
  }, [day, trip?.id, path, detail?.place.id, sheetExpanded]);
  const openPlace = (place: Place) => {
    detailOrigin.current = path;
    const warmed = cachedPlaceContent(place.id);
    setDetail({ place: warmed?.place || place, reviews: [], rating: null, content: warmed });
    setDetailTab("overview");
    setContentStatus(warmed?.status || (/^amap-/.test(place.id) ? "loading" : "local"));
    warmPlace(place, 0);
    navigate(`/destination/${encodeURIComponent(place.id)}`);
  };
  const favorite = async (id: string) => {
    try {
      const d = await post<{ favorite: boolean }>(
        `/favorites/${encodeURIComponent(id)}`,
      );
      setFavorites((old) =>
        d.favorite
          ? [...old.filter((x) => x !== id), id]
          : old.filter((x) => x !== id),
      );
      if (!d.favorite)
        setFavoritePlaces((old) => old.filter((p) => p.id !== id));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const showFavorites = async () => {
    setModal({ type: "favorites" });
    try {
      setFavoritePlaces(await api<Place[]>("/favorites"));
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const generate = async (text: string, adjust = false, authenticatedUser = user) => {
    if (busy) return;
    if (!text.trim()) {
      notify("先说说你想去哪里");
      return;
    }
    if (!authenticatedUser?.username) {
      pendingAI.current = { text, adjust };
      setModal({ type: "auth" });
      return;
    }
    let conv = adjust ? conversationId : undefined;
    const oldMessages = adjust ? messages : [];
    setMessages([...oldMessages, { role: "user", content: text.trim() }]);
    setConversationId(conv);
    setChatInput("");
    setChatError("");
    setBusy(true);
    setProgress("正在理解你的旅行想法…");
    if (!adjust) {
      setTrip(null);
      setAudit(null);
    }
    navigate(`/ai/chat/${conv || "new"}`);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await streamChat(
        {
          message: text.trim(),
          conversationId: conv,
          tripId: adjust && trip?.id !== "demo" ? trip?.id : undefined,
        },
        controller.signal,
        (event, data) => {
          if (event === "conversation") {
            setConversationId(data.id);
            window.history.replaceState({ ...window.history.state }, "", `/ai/chat/${data.id}`);
            setPath(`/ai/chat/${data.id}`);
          } else if (event === "progress") setProgress(data.content);
          else if (event === "result") {
            setMessages((old) => [
              ...old,
              { role: "assistant", content: data.reply },
            ]);
            if (data.trip) {
              useBundle(data);
              setAudit(data.audit);
            }
          } else if (event === "error") {
            setChatError(data.error);
            setChatInput(text);
          }
        },
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setChatError("已取消规划，需求已保留");
        setChatInput(text);
      } else {
        setChatError((e as Error).message);
        setChatInput(text);
        if (e instanceof ApiError && e.code === "LOGIN_REQUIRED") {
          setMessages(oldMessages);
          pendingAI.current = { text, adjust };
          setModal({ type: "auth" });
        }
      }
    } finally {
      setBusy(false);
      setProgress("");
      abort.current = null;
    }
  };
  const saveCurrent = async (next = trip): Promise<Trip | null> => {
    if (!next) return null;
    const b =
      next.id === "demo"
        ? await post<TripBundle>("/trips", next)
        : await patch<TripBundle>(`/trips/${next.id}`, next);
    setTrip(b.trip);
    addPlaces(b.places);
    setAudit(null);
    return b.trip;
  };
  const changeTrip = async (next: Trip) => {
    setWorking(true);
    try {
      const saved = await saveCurrent(next);
      if (saved && path.startsWith("/itinerary/")) {
        window.history.replaceState({ ...window.history.state }, "", `/itinerary/${saved.id}`);
        setPath(`/itinerary/${saved.id}`);
      }
      setModal(null);
      notify("行程已保存");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const exportTrip = async () => {
    if (!trip) return;
    try {
      let exported;
      if (trip.id === "demo" || path.startsWith("/share/"))
        exported = await downloadFile(
          {
            format: "roamly.itinerary",
            version: "1.0",
            exportedAt: new Date().toISOString(),
            itinerary: trip,
            places: [
              ...new Set(
                trip.days.flatMap((d) => d.items.map((i) => i.placeId)),
              ),
            ]
              .filter(Boolean)
              .map((id) => places[id!]),
          },
          trip.title,
        );
      else
        exported = await downloadFile(
          await api<TripFile>(`/trips/${trip.id}/export`),
          trip.title,
        );
      if (exported) notify("行程文件已导出");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const importTrip = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      notify("行程文件不能超过 2 MB");
      return;
    }
    try {
      const data = JSON.parse(await file.text());
      const b = await post<TripBundle>("/trips/import", data);
      useBundle(b);
      navigate(`/itinerary/${b.trip.id}`);
      notify("行程已导入");
    } catch (e) {
      notify(
        e instanceof SyntaxError
          ? "文件不是有效的漫迹行程"
          : (e as Error).message,
      );
    }
  };
  const shareTrip = async () => {
    if (!trip) return;
    setModal({ type: "share" });
    setSharePath("");
    setWorking(true);
    try {
      const saved = trip.id === "demo" ? await saveCurrent() : trip;
      const d = await post<{ path: string }>(`/trips/${saved!.id}/share`);
      setSharePath(`${window.location.origin}${d.path}`);
    } catch (e) {
      notify((e as Error).message);
      setModal(null);
    } finally {
      setWorking(false);
    }
  };
  const toggleTripFavorite = async () => {
    if (!trip) return;
    try {
      const saved = trip.id === "demo" ? await saveCurrent() : trip;
      const b = await patch<TripBundle>(`/trips/${saved!.id}`, {
        favorite: !trip.favorite,
      });
      setTrip(b.trip);
      setAudit(b.audit || null);
      notify(!trip.favorite ? "行程已收藏" : "已取消收藏");
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const startTrip = async () => {
    if (!trip) return;
    try {
      let current = trip.id === "demo" ? await saveCurrent() : trip;
      const status = current?.status === "started" ? "completed" : "started";
      const b = await patch<TripBundle>(`/trips/${current!.id}`, { status });
      setTrip(b.trip);
      setSheetExpanded(false);
      navigate(`/itinerary/${b.trip.id}`);
      notify(
        status === "completed"
          ? "这段旅程已记入足迹"
          : "旅程开始，祝你一路好风景",
      );
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const checkRoute = async () => {
    if (!trip || trip.id === "demo") {
      notify("示例的海外路线暂未接入，国内行程可用高德核验");
      return;
    }
    setWorking(true);
    try {
      const a = await post<Audit>(`/trips/${trip.id}/audit`);
      setAudit(a);
      notify(
        a.days.some((d) => d.warnings.length) || a.quality?.issues.length
          ? "核验完成，请查看交通提醒"
          : a.days.some((d) => d.legs.length)
            ? "景点间交通已核验"
            : "日程核验完成",
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const revise = (authenticatedUser = user) => {
    if (!authenticatedUser?.username) {
      pendingAI.current = "revise";
      setModal({ type: "auth" });
      return;
    }
    setChatError("");
    setChatInput("");
    setConversationId(undefined);
    setMessages([
      {
        role: "assistant",
        content: "想增减景点、换一种节奏，或者调整哪一天？告诉我就好。",
      },
    ]);
    navigate("/ai/chat/new");
  };
  const manualCreate = async (city: string, count: number, place?: Place) => {
    if (!user) return;
    setWorking(true);
    try {
      const now = new Date().toISOString();
      const b = await post<TripBundle>("/trips", {
        id: "new",
        title: `${city} · ${count} 日游`,
        city,
        summary: `你的 ${count} 日旅行`,
        preferences: user.preferences,
        createdAt: now,
        updatedAt: now,
        days: Array.from({ length: count }, (_, i) => ({
          index: i + 1,
          date: null,
          title: i === 0 ? "从这里出发" : "按自己的节奏走",
          items:
            i === 0 && place
              ? [
                  {
                    id: newId(),
                    kind: "place",
                    placeId: place.id,
                    title: place.name,
                    arrival: "09:30",
                    durationMinutes: place.suggestedMinutes,
                    notes: "",
                  },
                ]
              : [],
        })),
      });
      useBundle(b);
      navigate(`/itinerary/${b.trip.id}`);
      setModal(null);
      notify("新行程已准备好，添加你想去的地方");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const isDetail = path.startsWith("/destination/");
  const isChat = path.startsWith("/ai/chat/");
  const isItinerary =
    path.startsWith("/itinerary/") || path.startsWith("/share/");
  const isShared = path.startsWith("/share/");
  const activeNav = isItinerary ? "/trips" : path;
  const currentDay = trip?.days.find((d) => d.index === day) || trip?.days[0];
  useContentMotion(timeline, `${trip?.id}:${currentDay?.index}`, ".timeline-content");
  useContentMotion(scroll, `${path}:${filter}:${featured.length}:${trips.map((t) => t.id).join(',')}`, ".destination-card, .saved-trip-card, .draft-card");
  const dayPlaces =
    currentDay?.items
      .filter((i) => i.placeId)
      .map((i) => places[i.placeId!])
      .filter(Boolean) || [];
  const dailyAudit = audit?.days.find((d) => d.index === day);
  const planWarnings = [
    ...new Set([
      ...(dailyAudit?.warnings || []),
      ...(audit?.quality?.issues.filter((i) => !i.day).map((i) => i.message) ||
        []),
    ]),
  ];
  const dayAudit =
    dailyAudit && audit ? { ...audit, days: [dailyAudit] } : null;
  const backFromPlan = () => navigate(isShared ? "/home" : "/trips");
  return (
    <div className="desktop-stage">
      <div
        className={`app-shell ${isDetail || isChat || isItinerary ? "immersive" : ""}`}
      >
        <nav className="navigation" aria-label="主导航">
          <a
            className="brand"
            href="/home"
            onClick={(e) => {
              e.preventDefault();
              navigate("/home");
            }}
            aria-label="漫迹首页"
          >
            <img src="/favicon.svg" alt="" />
            <span>Roamly</span>
          </a>
          <div className="nav-items">
            {[
              [Home, "首页", "/home"],
              [Compass, "探索", "/explore"],
              [Clock, "行程", "/trips"],
              [UserRound, "我的", "/me"],
            ].map(([Icon, label, url]) => {
              const I = Icon as typeof Home;
              return (
                <button
                  key={url as string}
                  title={label as string}
                  aria-label={label as string}
                  aria-current={activeNav === url ? "page" : undefined}
                  className={activeNav === url ? "active" : ""}
                  onClick={() => navigate(url as string)}
                >
                  <span className="nav-icon">
                    {activeNav === url ? (
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        {url === "/home" && <>
                          <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <path d="M9 21v-8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v8z" fill="white" stroke="none" />
                          <path d="M9 21h6" fill="none" />
                        </>}
                        {url === "/explore" && <>
                          <circle cx="12" cy="12" r="10" />
                          <path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" fill="white" stroke="white" />
                        </>}
                        {url === "/trips" && <>
                          <circle cx="12" cy="12" r="10" />
                          <path d="M12 6v6l4 2" fill="none" stroke="white" />
                        </>}
                        {url === "/me" && <>
                          <circle cx="12" cy="8" r="5" />
                          <path d="M20 21a8 8 0 0 0-16 0z" />
                        </>}
                      </svg>
                    ) : <I size={24} strokeWidth={1.7} />}
                  </span>
                  <i aria-hidden="true" />
                </button>
              );
            })}
          </div>
          <div className="nav-footer">
            <span>漫迹</span>
          </div>
        </nav>
        <main
          ref={surface}
          className={`main-surface ${isItinerary ? "plan-surface" : ""} ${isChat ? "chat-surface" : ""}`}
        >
          {loading ? (
            <div className="full-loading">
              <LoaderCircle className="spin" />
              <span>漫迹 Roamly</span>
            </div>
          ) : loadError ? (
            <div className="error-screen">
              <CircleAlert />
              <h2>暂时没能打开</h2>
              <p>{loadError}</p>
              <button
                className="primary"
                onClick={() => {
                  setLoadError("");
                  bootstrap();
                }}
              >
                重试
              </button>
              <button className="secondary" onClick={() => navigate("/home")}>
                回到首页
              </button>
            </div>
          ) : (
            <>
              {(path === "/home" || path === "/") && (
                <div className="scroll-page home-page" ref={scroll}>
                  <header className="welcome">
                    <div>
                      <h1>
                        嗨，{user?.nickname} <span className="wave">👋</span>
                      </h1>
                      <p>探索世界，规划下一段旅程</p>
                    </div>
                    <button
                      className="avatar"
                      aria-label="打开个人主页"
                      onClick={() => navigate("/me")}
                    >
                      <img src="/images/default-avatar.png" alt="" />
                    </button>
                  </header>
                  <PlannerInput
                    value={request}
                    onChange={setRequest}
                    onSubmit={() => generate(request)}
                  />
                  <div className="section-heading">
                    <h2>热门目的地</h2>
                    <button onClick={() => navigate("/explore")}>
                      查看全部
                    </button>
                  </div>
                  <div className="destination-carousel">
                    {featured.map((p) => (
                      <PlaceCard
                        key={p.id}
                        place={p}
                        onOpen={() => openPlace(p)}
                        onFavorite={() => favorite(p.id)}
                        favorite={favorites.includes(p.id)}
                      />
                    ))}
                  </div>
                  <button
                    className="demo-link"
                    onClick={() => navigate("/itinerary/demo")}
                  >
                    看看 3 日慢游示例
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
              {path === "/explore" && (
                <div className="explore-page">
                  <MapView
                    places={trip ? dayPlaces : []}
                    audit={dayAudit}
                    onSelect={selectMapPlace}
                    focusId={focused}
                    onOpenPlace={openPlace}
                    onDeselect={() => setFocused(null)}
                  />
                  <div className="explore-welcome" data-map-obstacle="top">
                    <div>
                      <p>嗨，{user?.nickname} 👋</p>
                      <h1>下一站，去哪里？</h1>
                    </div>
                    <button
                      className="avatar"
                      onClick={() => navigate("/me")}
                      aria-label="我的"
                    >
                      <img src="/images/default-avatar.png" alt="" />
                    </button>
                  </div>
                  <div className="explore-planner" data-map-obstacle="bottom">
                    <PlannerInput
                      value={request}
                      onChange={setRequest}
                      onSubmit={() => generate(request)}
                    />
                    <button
                      className="secondary full"
                      onClick={() => setModal({ type: "add" })}
                    >
                      <Plus size={18} />
                      搜索想去的景点
                    </button>
                  </div>
                </div>
              )}
              {path === "/trips" && (
                <div className={`scroll-page trips-page ${deleteTarget ? "delete-confirm-open" : ""}`} ref={scroll}>
                  <div className="section-heading top-heading">
                    <h1>我的行程</h1>
                    <div className="inline-actions">
                      <IconButton
                        label="导入行程文件"
                        onClick={() => fileInput.current?.click()}
                      >
                        <Download size={21} />
                      </IconButton>
                      {filter !== "favorite" && <IconButton
                        className="trip-delete-toggle"
                        label={deleteMode ? "完成删除" : "删除行程"}
                        pressed={deleteMode}
                        onClick={() => setDeleteMode((current) => !current)}
                      >
                        <Trash2 size={21} />
                      </IconButton>}
                      <IconButton
                        className="dark-icon"
                        label="新建行程"
                        onClick={() => setModal({ type: "new" })}
                      >
                        <Plus size={23} />
                      </IconButton>
                    </div>
                  </div>
                  <MotionTabs className="segmented" value={filter} aria-label="行程筛选">
                    {[
                      ["saved", "全部行程"],
                      ["favorite", "已收藏"],
                      ["completed", "旅行足迹"],
                    ].map(([key, label]) => (
                      <button
                        key={key}
                        className={filter === key ? "selected" : ""}
                        onClick={() => {
                          setDeleteMode(false);
                          setDeleteTarget(null);
                          setDeleteError("");
                          setFilter(key);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </MotionTabs>
                  <div className="trip-grid">
                    {trips
                      .filter((t) =>
                        filter === "favorite"
                          ? t.favorite
                          : filter === "completed"
                            ? t.footprintVisible ?? t.status === "completed"
                            : t.savedVisible !== false,
                      )
                      .map((t) => {
                        const cover = t.days
                          .flatMap((d) => d.items)
                          .find((i) => i.placeId && places[i.placeId!]?.photo);
                        const p =
                          t.cover || (cover ? places[cover.placeId!] : null);
                        return (
                          <article key={t.id} className={`saved-trip-card ${deleteMode && filter !== "favorite" ? "is-delete-mode" : ""}`}>
                            <button
                              className="saved-trip-main"
                              onClick={() => {
                                setTrip(null);
                                navigate(`/itinerary/${t.id}`);
                              }}
                            >
                              {p && <Photo place={p} />}
                              <div className="glass-caption">
                                <h3>{t.title}</h3>
                                <p>
                                  {t.days.length} 天 · {t.preferences.travelers}{" "}
                                  人同行 · <time dateTime={t.updatedAt}>{shortDate(t.updatedAt)} 更新</time>
                                </p>
                              </div>
                            </button>
                            {deleteMode && filter !== "favorite" && <IconButton
                              className="delete-button trip-delete-button"
                              label={`删除行程：${t.title}`}
                              disabled={busy && trip?.id === t.id}
                              onClick={() => requestDelete({ kind: "trip", id: t.id, title: t.title, scope: filter === "completed" ? "footprint" : "saved" })}
                            >
                              <Trash2 size={19} />
                            </IconButton>}
                            <IconButton
                              className={`favorite-button ${t.favorite ? "is-favorite" : ""}`}
                              label={t.favorite ? "取消行程收藏" : "收藏行程"}
                              pressed={t.favorite}
                              onClick={async () => {
                                try {
                                  await patch(`/trips/${t.id}`, {
                                    favorite: !t.favorite,
                                  });
                                  reloadTrips();
                                } catch (e) {
                                  notify((e as Error).message);
                                }
                              }}
                            >
                              <Heart
                                size={21}
                                fill={t.favorite ? "currentColor" : "none"}
                              />
                            </IconButton>
                          </article>
                        );
                      })}
                  </div>
                  {!trips.filter((t) =>
                    filter === "favorite"
                      ? t.favorite
                      : filter === "completed"
                        ? t.footprintVisible ?? t.status === "completed"
                        : t.savedVisible !== false,
                  ).length && (
                    <Empty
                      icon={<Compass size={32} />}
                      action={
                        <button
                          className="primary"
                          onClick={() => navigate("/home")}
                        >
                          规划一段旅程
                        </button>
                      }
                    >
                      {filter === "favorite"
                        ? "喜欢的路线，留在这里"
                        : filter === "completed"
                          ? "走过的风景，会慢慢积累"
                          : "下一段旅程，从一个想法开始"}
                    </Empty>
                  )}
                  {filter !== "favorite" && <><div className="section-heading">
                    <h2>灵感草稿</h2>
                    <button onClick={() => navigate("/home")}>新灵感</button>
                  </div>
                  {conversations
                    .filter((c) => !c.trip_id)
                    .map((c) => (
                      <article
                        className="draft-card draft-row"
                        key={c.id}
                      >
                        <button className="draft-main" onClick={() => navigate(`/ai/chat/${c.id}`)}>
                          <div className="draft-icon">
                            <Globe2 />
                          </div>
                          <div>
                            <strong>
                              {c.messages
                                .find((m) => m.role === "user")
                                ?.content.slice(0, 45) || "一个新的旅行想法"}
                            </strong>
                            <p>继续和 AI 聊聊</p>
                          </div>
                          <ChevronRight size={18} />
                        </button>
                        <IconButton
                          className="draft-delete-button"
                          label={`删除草稿：${c.messages.find((m) => m.role === "user")?.content.slice(0, 45) || "一个新的旅行想法"}`}
                          disabled={busy && conversationId === c.id}
                          onClick={() => requestDelete({
                            kind: "draft", id: c.id,
                            title: c.messages.find((m) => m.role === "user")?.content.slice(0, 45) || "一个新的旅行想法",
                          })}
                        >
                          <Trash2 size={19} />
                        </IconButton>
                      </article>
                    ))}
                  {!conversations.filter((c) => !c.trip_id).length && (
                    <p className="quiet-note">还没想好去哪儿，也可以先聊聊。</p>
                  )}</>}
                  <button
                    className="demo-link"
                    onClick={() => navigate("/itinerary/demo")}
                  >
                    查看设计示例行程
                    <ChevronRight size={16} />
                  </button>
                </div>
              )}
              {path === "/me" && (
                <div className="scroll-page profile-page" ref={scroll}>
                  <div className="section-heading top-heading">
                    <h1>我的</h1>
                    <IconButton
                      label="编辑旅行偏好"
                      onClick={() => setModal({ type: "preferences" })}
                    >
                      <SlidersHorizontal size={23} />
                    </IconButton>
                  </div>
                  <div className="profile-identity">
                    <img
                      className="profile-avatar"
                      src="/images/default-avatar.png"
                      alt=""
                    />
                    <div>
                      <h2>{user?.nickname}</h2>
                      <p>{user?.username ? "已登录，行程随账号保存" : "登录后即可与 AI 规划旅程"}</p>
                    </div>
                    <IconButton
                      label="编辑个人资料"
                      onClick={() => setModal({ type: "preferences" })}
                    >
                      <Pencil size={18} />
                    </IconButton>
                  </div>
                  <div className="stats-card">
                    {[
                      [stats.visited, "旅行足迹"],
                      [stats.favorites, "收藏地点"],
                      [stats.trips, "已存攻略"],
                    ].map(([n, l]) => (
                      <div key={l}>
                        <strong>{n}</strong>
                        <span>{l}</span>
                      </div>
                    ))}
                  </div>
                  <section className="preference-card">
                    <h2>
                      <Sparkles size={21} />让 AI 更懂你的旅行
                    </h2>
                    <div className="preference-chips">
                      <span>
                        {user?.preferences.interests[0] || "随心探索"}
                      </span>
                      <span>{paceText[user!.preferences.pace]}</span>
                      <button onClick={() => setModal({ type: "preferences" })}>
                        <Plus size={15} />
                        编辑偏好
                      </button>
                    </div>
                  </section>
                  <div className="services-card">
                    <Row
                      icon={<Heart size={21} />}
                      label="我的收藏"
                      value={`${stats.favorites} 个地点`}
                      onClick={showFavorites}
                    />
                    <Row
                      icon={<SlidersHorizontal size={21} />}
                      label="预算与出行偏好"
                      onClick={() => setModal({ type: "preferences" })}
                    />
                    <Row
                      icon={<Link2 size={21} />}
                      label="管理分享链接"
                      onClick={async () => {
                        setModal({ type: "shares" });
                        setMyShares(await api<any[]>("/my-shares"));
                      }}
                    />
                    <Row
                      icon={<Download size={21} />}
                      label="导入旅行计划"
                      onClick={() => fileInput.current?.click()}
                    />
                    <Row
                      icon={<UserRound size={21} />}
                      label={user?.username ? "切换账号" : "登录与跨设备同步"}
                      onClick={() => setModal({ type: "auth" })}
                    />
                    {user?.username && (
                      <>
                      <Row
                        icon={<LogOut size={21} />}
                        label="退出登录"
                        onClick={async () => {
                          await post("/auth/logout");
                          setTrip(null);
                          setAudit(null);
                          setMessages([]);
                          setConversationId(undefined);
                          setTrips([]);
                          setConversations([]);
                          setMyShares([]);
                          await bootstrap();
                          await loadProfile();
                          notify("已退出登录");
                        }}
                      />
                      <Row
                        icon={<Trash2 size={21} />}
                        label="注销账号"
                        onClick={() => setModal({ type: "delete-account" })}
                      />
                      </>
                    )}
                  </div>
                  <p className="quiet-note">世界很大，下一站由你决定。</p>
                </div>
              )}
              {isChat && (
                <>
                  <Back
                    onClick={() => navigate("/home")}
                    title="AI 旅伴"
                    actions={
                      <IconButton
                        label="旅行偏好"
                        onClick={() => setModal({ type: "preferences" })}
                      >
                        <SlidersHorizontal size={21} />
                      </IconButton>
                    }
                  />
                  <div
                    className="chat-scroll"
                    onScroll={(e) => {
                      chatNearBottom.current =
                        e.currentTarget.scrollHeight -
                          e.currentTarget.scrollTop -
                          e.currentTarget.clientHeight <
                        100;
                    }}
                  >
                    {trip && (
                      <button
                        className="chat-trip-preview"
                        onClick={() => navigate(`/itinerary/${trip.id}`)}
                      >
                        <div className="preview-photo">
                          {places[
                            trip.days
                              .flatMap((d) => d.items)
                              .find((i) => i.placeId)?.placeId || ""
                          ]?.photo ? (
                            <img
                              src={
                                places[
                                  trip.days
                                    .flatMap((d) => d.items)
                                    .find((i) => i.placeId)?.placeId || ""
                                ].photo
                              }
                              alt=""
                            />
                          ) : (
                            <Route size={38} />
                          )}
                        </div>
                        <div>
                          <strong>{trip.title}</strong>
                          <span>
                            {trip.days.length} 天 · {trip.preferences.travelers}{" "}
                            人
                          </span>
                        </div>
                        <ChevronRight size={20} />
                      </button>
                    )}
                    {messages.length === 0 && (
                      <Empty icon={<Sparkles size={32} />}>
                        说说你想去的地方，或先添加想去的景点。
                      </Empty>
                    )}
                    {messages.map((m, i) => (
                      <div key={i} className={`chat-message ${m.role}`}>
                        {m.role === "assistant" && (
                          <div className="assistant-label">
                            <Sparkles size={18} />
                            漫迹旅伴
                          </div>
                        )}
                        <p>{m.content}</p>
                      </div>
                    ))}
                    {busy && (
                      <div className="chat-message assistant">
                        <div className="assistant-label">
                          <LoaderCircle className="spin" size={17} />
                          {progress}
                        </div>
                        <button
                          className="text-button"
                          onClick={() => abort.current?.abort()}
                        >
                          取消规划
                        </button>
                      </div>
                    )}
                    {chatError && (
                      <div className="chat-error" role="alert">
                        <CircleAlert size={18} />
                        <p>{chatError}</p>
                      </div>
                    )}
                    {trip && !busy && (
                      <section className="chat-result">
                        <div className="result-stats">
                          <div>
                            <strong>{trip.days.length} 天</strong>
                            <span>旅行时长</span>
                          </div>
                          <div>
                            <strong>{trip.preferences.travelers} 人</strong>
                            <span>同行人数</span>
                          </div>
                          {trip.preferences.budget !== null && (
                            <div>
                              <strong>
                                ¥{trip.preferences.budget.toLocaleString()}
                              </strong>
                              <span>人均预算</span>
                            </div>
                          )}
                        </div>
                        <button
                          className="primary"
                          onClick={() => navigate(`/itinerary/${trip.id}`)}
                        >
                          查看完整 {trip.days.length} 日攻略
                          <ChevronRight size={18} />
                        </button>
                      </section>
                    )}
                    <div ref={messageEnd} />
                  </div>
                  <div className="chat-composer">
                    {!busy && (
                      <div className="quick-prompts">
                        {["再加一些美食", "我想少走路", "节奏再轻松一点"].map(
                          (s) => (
                            <button key={s} onClick={() => generate(s, true)}>
                              {s}
                            </button>
                          ),
                        )}
                      </div>
                    )}
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        generate(chatInput, true);
                      }}
                    >
                      <IconButton
                        label="添加指定景点"
                        onClick={() => setModal({ type: "add" })}
                      >
                        <Plus size={21} />
                      </IconButton>
                      <textarea
                        aria-label="继续对话"
                        rows={1}
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        placeholder="继续说说你的想法…"
                        maxLength={4000}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.nativeEvent.isComposing
                          ) {
                            e.preventDefault();
                            generate(chatInput, true);
                          }
                        }}
                      />
                      <button
                        className="send-button"
                        type="submit"
                        aria-label="发送需求"
                        disabled={busy || !chatInput.trim()}
                      >
                        <Send size={21} />
                      </button>
                    </form>
                  </div>
                </>
              )}
              {isItinerary && trip && (
                <div className="itinerary-page">
                  <MapView
                    places={dayPlaces}
                    audit={dayAudit}
                    onSelect={selectMapPlace}
                    focusId={focused}
                    onOpenPlace={openPlace}
                    onDeselect={() => setFocused(null)}
                    overseas={
                      dayPlaces.length > 0 &&
                      dayPlaces.every((p) => p.location.coordSystem === "WGS84")
                    }
                  />
                  <div className="floating-plan-header" data-map-obstacle="top">
                    <div className="header-leading">
                      <IconButton label="返回" onClick={backFromPlan}>
                        <ChevronRight className="flip" size={22} />
                      </IconButton>
                      <h1>{trip.title}</h1>
                    </div>
                    <div className="inline-actions">
                      {!isShared && (
                        <IconButton
                          label={trip.favorite ? "取消行程收藏" : "收藏行程"}
                          className="white-float"
                          pressed={Boolean(trip.favorite)}
                          onClick={toggleTripFavorite}
                        >
                          <Heart
                            size={21}
                            fill={trip.favorite ? "currentColor" : "none"}
                          />
                        </IconButton>
                      )}
                      <IconButton
                        label="行程分享与导出"
                        className="white-float"
                        onClick={isShared ? exportTrip : shareTrip}
                      >
                        {isShared ? (
                          <Download size={21} />
                        ) : (
                          <Share2 size={21} />
                        )}
                      </IconButton>
                    </div>
                  </div>
                  <section
                    className={`itinerary-sheet ${sheetExpanded ? "expanded" : "collapsed"}`}
                    data-map-obstacle="bottom"
                  >
                    <button
                      className="sheet-handle"
                      aria-label={
                        sheetExpanded ? "收起日程，展开地图" : "展开日程"
                      }
                      aria-expanded={sheetExpanded}
                      onClick={() => {
                        if (dragHandled.current) {
                          dragHandled.current = false;
                          return;
                        }
                        setSheetExpanded((v) => !v);
                      }}
                      onPointerDown={(e) => {
                        dragHandled.current = false;
                        dragStart.current = e.clientY;
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerUp={(e) => {
                        if (
                          dragStart.current !== null &&
                          Math.abs(e.clientY - dragStart.current) > 25
                        ) {
                          setSheetExpanded(e.clientY < dragStart.current);
                          dragStart.current = null;
                          dragHandled.current = true;
                          e.preventDefault();
                        } else dragStart.current = null;
                      }}
                      onPointerCancel={() => {
                        dragStart.current = null;
                        dragHandled.current = false;
                      }}
                    >
                      <span />
                    </button>
                    <div className="sheet-heading">
                      <div>
                        <h2>
                          {trip.id === "demo"
                            ? trip.summary
                            : `你的 ${trip.days.length} 日旅行攻略`}
                        </h2>
                        <p>
                          {trip.preferences.travelers} 人出行 ·{" "}
                          {trip.preferences.interests.join("、")} ·{" "}
                          {paceText[trip.preferences.pace]}
                        </p>
                      </div>
                      {!isShared && (
                        <IconButton
                          label="添加或编辑景点"
                          onClick={() => setModal({ type: "add", day })}
                        >
                          <SlidersHorizontal size={21} />
                        </IconButton>
                      )}
                    </div>
                    <MotionTabs
                      className="day-tabs"
                      scrollable
                      value={day}
                      role="tablist"
                      aria-label="行程日期"
                    >
                      {trip.days.map((d) => (
                        <button
                          key={d.index}
                          role="tab"
                          aria-selected={d.index === day}
                          className={d.index === day ? "selected" : ""}
                          onClick={() => {
                            if (timeline.current)
                              dayScroll.current[`${trip.id}:${day}`] =
                                timeline.current.scrollTop;
                            setDay(d.index);
                            setFocused(null);
                          }}
                        >
                          Day {String(d.index).padStart(2, "0")}
                          {d.date
                            ? ` · ${d.date.slice(5).replace("-", "月")}日`
                            : ""}
                        </button>
                      ))}
                    </MotionTabs>
                    <MotionPresence show={sheetExpanded} variant="fade">
                    <div
                      className="timeline-scroll"
                      ref={timeline}
                      inert={!sheetExpanded}
                      aria-hidden={!sheetExpanded}
                    >
                      <div className="day-heading">
                        <h3>{currentDay?.title}</h3>
                        {trip.preferences.transport === "auto" && currentDay?.transport && (
                          <span className="sample-label">
                            {currentDay.transport === "driving" ? "自驾日 · 需准备车辆" : transportText[currentDay.transport]}
                          </span>
                        )}
                        {trip.id === "demo" && (
                          <span className="sample-label">设计示例</span>
                        )}
                      </div>
                      {planWarnings.length > 0 && (
                        <details className="route-warning plan-notices">
                          <summary>
                            <CircleAlert size={16} />
                            行程提醒（{planWarnings.length}）
                          </summary>
                          <ul>
                            {planWarnings.map((w, i) => (
                              <li key={i}>{w}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {!currentDay?.items.length && (
                        <Empty
                          action={
                            !isShared && (
                              <button
                                className="secondary"
                                onClick={() => setModal({ type: "add", day })}
                              >
                                <Plus size={18} />
                                添加景点
                              </button>
                            )
                          }
                        >
                          这一天，留给你想去的地方
                        </Empty>
                      )}
                      <div className="timeline">
                        {currentDay?.items.map((item, i) => {
                          const p = item.placeId ? places[item.placeId] : null;
                          const next = currentDay.items[i + 1];
                          const previousPlace = [
                            ...currentDay.items.slice(0, i + 1),
                          ]
                            .reverse()
                            .find((x) => x.kind === "place");
                          const leg = dailyAudit?.legs.find(
                            (l) =>
                              l.itemFrom === previousPlace?.id &&
                              l.itemTo === next?.id,
                          );
                          const T =
                            icons[
                              (leg?.mode as keyof typeof icons) ||
                                trip.preferences.transport
                            ];
                          return (
                            <div key={item.id} className="timeline-entry">
                              <span className="timeline-time">
                                {item.arrival}
                              </span>
                              <i
                                className={`timeline-dot ${i === 0 ? "first" : ""}`}
                              />
                              <div className="timeline-content">
                                {item.kind === "place" && p ? (
                                  <article className="itinerary-place-card">
                                    <button
                                      className="itinerary-place-main"
                                      onClick={() => openPlace(p)}
                                    >
                                      <div className="itinerary-photo">
                                        <Photo place={p} />
                                        <span>
                                          停留{" "}
                                          {duration(item.durationMinutes)}
                                        </span>
                                      </div>
                                      <div className="itinerary-place-info glass-caption">
                                        <h4>{p.name}</h4>
                                        <p>
                                          <MapPin size={14} />
                                          <span>
                                            {item.notes || p.address || p.city}
                                          </span>
                                        </p>
                                      </div>
                                    </button>
                                    <IconButton
                                      className={`item-heart ${favorites.includes(p.id) ? "is-favorite" : ""}`}
                                      label={
                                        favorites.includes(p.id)
                                          ? "取消景点收藏"
                                          : "收藏景点"
                                      }
                                      onClick={() => favorite(p.id)}
                                      pressed={favorites.includes(p.id)}
                                    >
                                      <Heart
                                        size={20}
                                        fill={
                                          favorites.includes(p.id)
                                            ? "currentColor"
                                            : "none"
                                        }
                                      />
                                    </IconButton>
                                    {!isShared && (
                                      <IconButton
                                        className="item-edit"
                                        label={`编辑${p.name}的日程`}
                                        onClick={() =>
                                          setModal({ type: "edit", item, day })
                                        }
                                      >
                                        <Pencil size={15} />
                                      </IconButton>
                                    )}
                                  </article>
                                ) : (
                                  <button
                                    className="break-card"
                                    onClick={() =>
                                      !isShared &&
                                      setModal({ type: "edit", item, day })
                                    }
                                  >
                                    <div className="coffee-icon">
                                      <Coffee size={34} strokeWidth={1.2} />
                                    </div>
                                    <div>
                                      <h4>{item.title}</h4>
                                      <p>{item.notes}</p>
                                      <span>
                                        自由安排 ·{" "}
                                        {duration(item.durationMinutes)}
                                      </span>
                                    </div>
                                  </button>
                                )}
                                {previousPlace && next?.kind === "place" && (
                                  <div className="transport-card">
                                    <T size={19} />
                                    <div>
                                      <strong>
                                        {leg?.status === "verified"
                                          ? `${transportText[leg.mode as keyof typeof transportText]} · 约 ${leg.minutes} 分钟`
                                          : `${transportText[trip.preferences.transport]} · 待核验`}
                                      </strong>
                                      {leg?.status === "verified" && (
                                        <span>
                                          {leg.distance! >= 1000
                                            ? `${(leg.distance! / 1000).toFixed(1)} 公里`
                                            : `${leg.distance} 米`}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {!isShared && (
                        <button
                          className="add-stop"
                          onClick={() => setModal({ type: "add", day })}
                        >
                          <Plus size={18} />
                          添加景点或休息
                        </button>
                      )}
                      <div className="plan-tools">
                        <button onClick={exportTrip}>
                          <Download size={17} />
                          导出行程
                        </button>
                        {!isShared && (
                          <button disabled={working} onClick={checkRoute}>
                            {working ? (
                              <LoaderCircle size={17} className="spin" />
                            ) : (
                              <Route size={17} />
                            )}
                            核验路线
                          </button>
                        )}
                      </div>
                    </div>
                    </MotionPresence>
                    {!isShared ? (
                      <footer className="sheet-actions">
                        <div className="action-row">
                          <button className="primary" onClick={startTrip}>
                            {trip.status === "started"
                              ? "完成这段旅程"
                              : "开始这段旅程"}
                            <Check size={18} />
                          </button>
                          <button className="secondary" onClick={() => revise()}>
                            <Sparkles size={18} aria-hidden="true" />
                            调整
                          </button>
                        </div>
                      </footer>
                    ) : (
                      <footer className="sheet-actions">
                        <button
                          className="primary full"
                          onClick={async () => {
                            try {
                              const b = await post<TripBundle>(
                                "/trips/import",
                                shared,
                              );
                              useBundle(b);
                              navigate(`/itinerary/${b.trip.id}`);
                              notify("已保存一份到我的行程");
                            } catch (e) {
                              notify((e as Error).message);
                            }
                          }}
                        >
                          保存到我的行程
                          <Heart size={18} />
                        </button>
                      </footer>
                    )}
                  </section>
                </div>
              )}
              {isDetail && detail && (
                <div className="detail-page">
                  <div className="detail-scroll" ref={scroll}>
                    <div className="detail-photo">
                      <PhotoGallery place={detail.place} />
                      <div className="detail-top-actions">
                        <IconButton
                          label="返回来源页面"
                          className="detail-photo-button"
                          onClick={() => navigate(detailOrigin.current)}
                        >
                          <ChevronRight className="flip" size={22} />
                        </IconButton>
                        <IconButton
                          label={
                            favorites.includes(detail.place.id)
                              ? "取消景点收藏"
                              : "收藏景点"
                          }
                          className="detail-photo-button"
                          pressed={favorites.includes(detail.place.id)}
                          onClick={() => favorite(detail.place.id)}
                        >
                          <Heart
                            size={21}
                            fill={
                              favorites.includes(detail.place.id)
                                ? "currentColor"
                                : "none"
                            }
                          />
                        </IconButton>

                      </div>
                      <div className="glass-caption detail-caption">
                        <div>
                          <h1>{detail.place.name}</h1>
                          <p>
                            <MapPin size={18} />
                            {detail.place.country} · {detail.place.city}
                          </p>
                        </div>
                        {detail.place.price !== null && (
                          <div className="place-price">
                            <small>参考门票</small>
                            <strong>
                              {detail.place.price === 0
                                ? "免费"
                                : `${detail.place.currency === "CNY" ? "¥" : detail.place.currency} ${detail.place.price}`}
                            </strong>
                          </div>
                        )}
                      </div>
                    </div>
                    <MotionTabs className="detail-tabs" role="tablist" aria-label="景点信息" value={detailTab}>
                      {[
                        ["overview", "概览"],
                        ["info", "详情"],
                        ["reviews", "旅行评价"],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          role="tab"
                          aria-selected={detailTab === id}
                          className={detailTab === id ? "active" : ""}
                          onClick={() => setDetailTab(id)}
                        >
                          {label}
                        </button>
                      ))}
                    </MotionTabs>
                    {detailTab === "overview" && (
                      <>
                        <div className="place-facts">
                          <span>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" /><path d="M12 6v6l4 2" fill="none" stroke="white" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                            {duration(detail.place.suggestedMinutes)}
                          </span>
                          <span>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" /><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" fill="white" /></svg>
                            {detail.place.category}
                          </span>
                          <span title="AI 综合旅行推荐评分，满分 5 分">
                            <Star size={20} fill="currentColor" strokeWidth={1.7} />
                            {detail.place.aiRating != null ? detail.place.aiRating.toFixed(1) : "待生成"}
                          </span>
                        </div>
                        <p className="place-overview">
                          {detail.place.overview ||
                            (contentStatus === "loading" ? "正在获取景点介绍…" : contentStatus === "error" ? "景点介绍暂时无法获取，请稍后重试。" : "暂无有来源支持的景点介绍。")}
                        </p>
                        {detail.place.overviewSource && <p className="overview-source"><a href={detail.place.overviewSource.url} target="_blank" rel="noopener noreferrer">{detail.place.overviewSource.title}</a><span>· {shortDate(detail.place.overviewSource.updatedAt)} 更新</span></p>}
                        <ContentNotice status={contentStatus} retryCount={detail.content?.automaticRetries} onRetry={() => setContentRetry((n) => n + 1)} />
                        <p className="source-note">
                          {detail.place.source.note}
                        </p>
                      </>
                    )}
                    {detailTab === "info" && (
                      <div className="place-info-list">
                        <div className="place-info-row">
                          <span className="place-info-label"><MapPin /><span>地址</span></span>
                          <p>{detail.place.address || detail.place.city}</p>
                        </div>
                        <div className="place-info-row">
                          <span className="place-info-label"><Clock3 /><span>营业时间</span></span>
                          <p>
                            {detail.place.openingHours ||
                              "暂未提供，出发前请向景点确认"}
                          </p>
                        </div>
                        <div className="place-info-row">
                          <span className="place-info-label"><Ticket /><span>购票预约</span></span>
                          <div className="place-info-value"><BookingChannels place={detail.place} status={contentStatus} notify={notify} /><ContentNotice status={contentStatus} retryCount={detail.content?.automaticRetries} onRetry={() => setContentRetry((n) => n + 1)} /></div>
                        </div>
                        <div className="place-info-row">
                          <span className="place-info-label"><Globe2 /><span>信息来源</span></span>
                          <p>
                            {detail.place.source.url ? <a
                              href={detail.place.source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {detail.place.source.provider}
                            </a> : detail.place.source.provider}{" "}
                            · {shortDate(detail.place.source.updatedAt)} 更新
                          </p>
                        </div>
                        <p className="source-note">
                          {detail.place.source.note}
                        </p>
                      </div>
                    )}
                    {detailTab === "reviews" && (
                      <ReviewPanel
                        detail={detail}
                        user={user!}
                        notify={notify}
                        onAuth={() => setModal({ type: "auth" })}
                        onRefresh={async () => {
                          setDetail(await api(`/places/${detail.place.id}`));
                        }}
                      />
                    )}
                  </div>
                  <footer className="detail-footer">
                    <button
                      className="primary full"
                      onClick={async () => {
                        await reloadTrips();
                        setModal({ type: "choose", place: detail.place });
                      }}
                    >
                      加入我的行程
                      <Send size={26} strokeWidth={1.7} />
                    </button>
                  </footer>
                </div>
              )}
              {isDetail && !detail && (
                <div className="full-loading">
                  <LoaderCircle className="spin" />
                </div>
              )}
            </>
          )}
        </main>
      </div>
      <input
        type="file"
        ref={fileInput}
        accept=".roamly,.json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importTrip(f);
          e.target.value = "";
        }}
      />
      <MotionPresence show={Boolean(toast)} motionKey={toast}>
        {toast && (
          <div className="toast" role="status">
            <CheckCircle2 size={18} />
            {toast}
          </div>
        )}
      </MotionPresence>
      {modal?.type === "new" && (
        <Modal title="新建一段旅程" onClose={() => setModal(null)}>
          <NewTripForm
            working={working}
            onCreate={manualCreate}
            onAI={() => {
              setModal(null);
              navigate("/home");
            }}
          />
        </Modal>
      )}
      {deleteTarget && (
        <Modal
          title={deleteTarget.kind === "trip" ? "删除行程" : "删除草稿"}
          onClose={() => setDeleteTarget(null)}
          closeDisabled={deleting}
        >
          <p className="delete-target-title">{deleteTarget.title}</p>
          <p className="modal-description">
            {deleteTarget.kind === "trip"
              ? deleteTarget.scope === "footprint"
                ? "仅移除这条旅行足迹，全部行程和收藏中的记录会保留。"
                : "从全部行程中移除，旅行足迹和收藏中的记录会保留。没有其他记录时，关联规划对话及分享链接也会删除。"
              : "该草稿及全部对话记录将被删除，删除后无法恢复。"}
          </p>
          {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
          <div className="delete-actions">
            <button className="secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</button>
            <button className="primary delete-confirm" onClick={deleteSaved} disabled={deleting}>
              {deleting ? <LoaderCircle className="spin" size={18} /> : <Trash2 size={18} />}
              {deleting ? "正在删除…" : "确认删除"}
            </button>
          </div>
        </Modal>
      )}
      {modal?.type === "preferences" && user && (
        <Modal title="你的旅行偏好" onClose={() => setModal(null)}>
          <PreferenceForm
            user={user}
            working={working}
            onSave={async (preferences) => {
              setWorking(true);
              try {
                setUser(await patch("/profile", { preferences }));
                setModal(null);
                notify("偏好已保存，下次规划会参考它");
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setWorking(false);
              }
            }}
          />
        </Modal>
      )}
      {modal?.type === "auth" && (
        <Modal title={authRegister ? "注册" : "登录"} className="auth-modal" onClose={() => { pendingAI.current = null; setModal(null); }}>
          <AuthForm
            register={authRegister}
            onModeChange={setAuthRegister}
            onSuccess={async (u) => {
              const intent = pendingAI.current;
              pendingAI.current = null;
              if (user?.username && user.id !== u.id) {
                setTrip(null);
                setAudit(null);
                setMessages([]);
                setConversationId(undefined);
              }
              setUser(u);
              setModal(null);
              await bootstrap();
              await loadProfile();
              await reloadTrips();
              notify("已登录，行程随账号保存");
              if (intent === "revise") revise(u);
              else if (intent) await generate(intent.text, intent.adjust, u);
            }}
          />
        </Modal>
      )}
      {modal?.type === "delete-account" && (
        <Modal title="注销账号" onClose={() => setModal(null)} closeDisabled={working}>
          <DeleteAccountForm
            onDeleted={async () => {
              setTrip(null);
              setAudit(null);
              setMessages([]);
              setConversationId(undefined);
              setChatInput("");
              setChatError("");
              setTrips([]);
              setConversations([]);
              setMyShares([]);
              setModal(null);
              await bootstrap();
              await loadProfile();
              notify("账号已注销，用户名已释放");
            }}
            onBusy={setWorking}
          />
        </Modal>
      )}
      {modal?.type === "add" && (
        <Modal title="添加想去的地方" onClose={() => setModal(null)} wide>
          <AddPlaceForm
            initialCity={trip?.city || ""}
            day={modal.day || day}
            trip={trip}
            working={working}
            onPlace={async (p) => {
              warmPlace(p);
              addPlaces([p]);
              if (!trip) {
                await manualCreate(p.city || p.name, 1, p);
              } else {
                setModal({ type: "edit", place: p, day: modal.day || day });
              }
            }}
            onBreak={() => {
              if (trip)
                setModal({
                  type: "edit",
                  day: modal.day || day,
                  item: {
                    id: newId(),
                    kind: "break",
                    placeId: null,
                    title: "午餐与休息",
                    arrival: nextTime(currentDay?.items || []),
                    durationMinutes: 60,
                    notes: "",
                  },
                });
            }}
          />
        </Modal>
      )}
      {modal?.type === "choose" && modal.place && (
        <Modal title="加入哪一段旅程？" onClose={() => setModal(null)}>
          <div className="choose-trips">
            {trips.map((t) => (
              <button
                key={t.id}
                className="draft-card"
                onClick={async () => {
                  const b = await api<TripBundle>(`/trips/${t.id}`);
                  useBundle(b);
                  setModal({ type: "edit", place: modal.place, day: 1 });
                }}
              >
                <Route size={23} />
                <span>{t.title}</span>
                <ChevronRight size={17} />
              </button>
            ))}
          </div>
          <button
            className="primary full"
            onClick={() =>
              manualCreate(
                modal.place!.city || modal.place!.name,
                1,
                modal.place,
              )
            }
          >
            <Plus size={18} />
            为这个景点新建行程
          </button>
        </Modal>
      )}
      {modal?.type === "edit" && trip && (
        <Modal
          title={modal.item ? "调整这一站" : "安排这一站"}
          onClose={() => setModal(null)}
        >
          <ItemForm
            trip={trip}
            item={modal.item}
            place={modal.place}
            initialDay={modal.day || day}
            working={working}
            onSave={changeTrip}
            onOpenPlan={() => navigate(`/itinerary/${trip.id}`)}
          />
        </Modal>
      )}
      {modal?.type === "favorites" && (
        <Modal title="我的收藏地点" onClose={() => setModal(null)} wide>
          <div className="favorite-list">
            {favoritePlaces.map((p) => (
              <button
                key={p.id}
                className="search-result"
                onClick={() => {
                  setModal(null);
                  openPlace(p);
                }}
              >
                <Photo place={p} />
                <div>
                  <strong>{p.name}</strong>
                  <span>
                    {p.city} · {p.category}
                  </span>
                </div>
                <ChevronRight size={19} />
              </button>
            ))}
          </div>
          {!favoritePlaces.length && (
            <Empty icon={<Heart size={30} />}>
              遇到喜欢的地方，就把它收藏起来。
            </Empty>
          )}
        </Modal>
      )}
      {modal?.type === "share" && (
        <Modal title="分享这段旅程" onClose={() => setModal(null)}>
          {working ? (
            <div className="modal-loading">
              <LoaderCircle className="spin" />
              正在准备分享链接
            </div>
          ) : (
            <>
              <p className="modal-description">
                朋友打开链接即可查看这版行程，也可以保存一份继续调整。
              </p>
              <div className="copy-field">
                <input aria-label="行程分享链接" value={sharePath} readOnly />
                <button
                  className="secondary"
                  onClick={async () => {
                    try {
                      await copyText(sharePath);
                      notify("分享链接已复制");
                    } catch {
                      notify("请长按或选中链接复制");
                    }
                  }}
                >
                  复制
                </button>
              </div>
              <p className="source-note">
                本地预览链接需访问同一台服务器；部署后即可跨设备分享。
              </p>
              <button className="primary full" onClick={exportTrip}>
                <Download size={18} />
                导出 .roamly 行程文件
              </button>
            </>
          )}
        </Modal>
      )}
      {modal?.type === "shares" && (
        <Modal title="管理分享链接" onClose={() => setModal(null)}>
          {myShares.map((s) => (
            <div className="share-row" key={s.token}>
              <div>
                <strong>
                  {trips.find((t) => t.id === s.trip_id)?.title ||
                    "已分享的行程"}
                </strong>
                <span>{shortDate(s.created_at)}</span>
              </div>
              <button
                className="secondary"
                onClick={async () => {
                  await api(`/shares/${s.token}`, { method: "DELETE" });
                  setMyShares((old) => old.filter((x) => x.token !== s.token));
                  notify("分享已撤回");
                }}
              >
                撤回
              </button>
            </div>
          ))}
          {!myShares.length && (
            <Empty icon={<Share2 />}>还没有分享链接。</Empty>
          )}
        </Modal>
      )}
    </div>
  );
}

function NewTripForm({
  onCreate,
  onAI,
  working,
}: {
  onCreate: (city: string, count: number) => void;
  onAI: () => void;
  working: boolean;
}) {
  const [city, setCity] = useState("");
  const [count, setCount] = useState(3);
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate(city, count);
      }}
    >
      <label>
        目的地
        <input
          required
          value={city}
          maxLength={100}
          onChange={(e) => setCity(e.target.value)}
          placeholder="例如：杭州"
        />
      </label>
      <label>
        旅行天数
        <input
          type="number"
          required
          min={1}
          max={14}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
        />
      </label>
      <button className="primary" disabled={working} type="submit">
        {working ? "正在创建…" : "手动安排我的行程"}
        <Plus size={18} />
      </button>
      <button type="button" className="secondary" onClick={onAI}>
        <Sparkles size={18} />
        交给 AI 来规划
      </button>
    </form>
  );
}
function PreferenceForm({
  user,
  working,
  onSave,
}: {
  user: User;
  working: boolean;
  onSave: (p: Preferences) => void;
}) {
  const [p, setP] = useState(user.preferences);
  const [interests, setInterests] = useState(p.interests.join("、"));
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          ...p,
          interests: interests
            .split(/[,，、]/)
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 10),
        });
      }}
    >
      <label>
        用户名
        <input value={user.username || "旅行者（未登录）"} readOnly />
      </label>
      <div className="form-columns">
        <label>
          出行人数
          <input
            type="number"
            min={1}
            max={50}
            required
            value={p.travelers}
            onChange={(e) => setP({ ...p, travelers: Number(e.target.value) })}
          />
        </label>
        <label>
          人均预算（元）
          <input
            type="number"
            min={0}
            value={p.budget ?? ""}
            placeholder="暂不确定"
            onChange={(e) =>
              setP({
                ...p,
                budget: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
        </label>
      </div>
      <label>
        旅行节奏
        <GlassSelect label="旅行节奏" value={p.pace} options={Object.entries(paceText).map(([value, label]) => ({ value, label }))} onChange={(value) => setP({ ...p, pace: value as Preferences["pace"] })} />
      </label>
      <label>
        交通方式
        <GlassSelect label="交通方式" value={p.transport} options={Object.entries(transportText).map(([value, label]) => ({ value, label }))} onChange={(value) => setP({ ...p, transport: value as Preferences["transport"] })} />
      </label>
      <label>
        喜欢的体验
        <input
          value={interests}
          maxLength={200}
          onChange={(e) => setInterests(e.target.value)}
          placeholder="自然风景、美食、人文"
        />
      </label>
      <button className="primary" disabled={working}>
        保存偏好
        <Check size={18} />
      </button>
    </form>
  );
}
function AuthForm({ onSuccess, register, onModeChange }: { onSuccess: (u: User) => Promise<void>; register: boolean; onModeChange: (register: boolean) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const u = await post<User>(`/auth/${register ? "register" : "login"}`, {
        username,
        password,
      });
      await onSuccess(u);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form-stack auth-form" onSubmit={submit}>
      <label>
        用户名
        <input
          required
          value={username}
          pattern={USERNAME_PATTERN}
          onChange={(e) => setUsername(limitCharacters(e.target.value, USERNAME_MAX_LENGTH))}
          autoComplete="username"
          placeholder="中文、英文或下划线，最多 12 字"
        />
      </label>
      <label>
        密码
        <input
          type="password"
          required
          minLength={register ? 8 : 1}
          value={password}
          onChange={(e) => setPassword(limitCharacters(e.target.value, PASSWORD_MAX_LENGTH))}
          autoComplete={register ? "new-password" : "current-password"}
          placeholder={register ? "8–16 位密码" : "最多 16 位"}
        />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? "请稍候…" : register ? "注册" : "登录"}
      </button>
      <button
        className="text-button"
        type="button"
        disabled={busy}
        onClick={() => {
          onModeChange(!register);
          setError("");
        }}
      >
        {register ? "已有账号，直接登录" : "第一次来？创建账号"}
      </button>
    </form>
  );
}
function DeleteAccountForm({ onDeleted, onBusy }: { onDeleted: () => Promise<void>; onBusy: (busy: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form className="form-stack" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      onBusy(true);
      setError("");
      try {
        await api("/auth/account", { method: "DELETE", body: JSON.stringify({ password }) });
        await onDeleted();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
        onBusy(false);
      }
    }}>
      <p className="source-note">注销后，用户名将释放，行程、收藏、对话及分享链接会删除。已发表的评论保留，作者显示为“用户已注销”。此操作无法恢复。</p>
      <label>确认当前密码
        <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(limitCharacters(e.target.value, PASSWORD_MAX_LENGTH))} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary delete-confirm" disabled={busy}>
        {busy ? "正在注销…" : "确认注销账号"}<Trash2 size={18} />
      </button>
    </form>
  );
}
function AddPlaceForm({
  initialCity,
  trip,
  working,
  onPlace,
  onBreak,
}: {
  initialCity: string;
  day: number;
  trip: Trip | null;
  working: boolean;
  onPlace: (p: Place) => void;
  onBreak: () => void;
}) {
  const [city, setCity] = useState(
    initialCity.includes("·") ? "" : initialCity,
  );
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  return (
    <>
      <form
        className="place-search-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return;
          setBusy(true);
          setError("");
          try {
            setResults(
              await api(
                `/places/search?q=${encodeURIComponent(q)}&city=${encodeURIComponent(city)}`,
              ),
            );
            setSearched(true);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-columns">
          <label>
            城市
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="杭州"
              maxLength={100}
            />
          </label>
          <label>
            景点名称
            <input
              value={q}
              required
              onChange={(e) => setQ(e.target.value)}
              placeholder="西湖、博物馆…"
              maxLength={100}
            />
          </label>
        </div>
        <button className="primary" disabled={busy}>
          {busy ? (
            <>
              <LoaderCircle className="spin" size={18} />
              正在查询
            </>
          ) : (
            "搜索景点"
          )}
          <MapPin size={18} />
        </button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="search-results">
        {results.map((p) => (
          <button
            className="search-result"
            key={p.id}
            disabled={working}
            onClick={() => onPlace(p)}
          >
            <Photo place={p} />
            <div>
              <strong>{p.name}</strong>
              <span>{p.address || p.city}</span>
            </div>
            <Plus size={20} />
          </button>
        ))}
      </div>
      {searched && !results.length && !error && (
        <Empty>没有找到，试试更具体的名称或城市。</Empty>
      )}
      {trip && (
        <button className="secondary full" onClick={onBreak}>
          <Coffee size={19} />
          添加午餐或休息时间
        </button>
      )}
    </>
  );
}
function ItemForm({
  trip,
  item,
  place,
  initialDay,
  working,
  onSave,
  onOpenPlan,
}: {
  trip: Trip;
  item?: Item;
  place?: Place;
  initialDay: number;
  working: boolean;
  onSave: (t: Trip) => void;
  onOpenPlan: () => void;
}) {
  const [day, setDay] = useState(initialDay);
  const [title, setTitle] = useState(item?.title || place?.name || "休息时间");
  const [arrival, setArrival] = useState(
    item?.arrival ||
      nextTime(trip.days.find((d) => d.index === initialDay)?.items || []),
  );
  const [stay, setStay] = useState(
    item?.durationMinutes || place?.suggestedMinutes || 60,
  );
  const [notes, setNotes] = useState(item?.notes || "");
  const save = (submittedArrival: string) => {
    const next: Item = {
      id: item?.id || newId(),
      kind: item?.kind || "place",
      placeId: item?.placeId || place?.id || null,
      title,
      arrival: submittedArrival,
      durationMinutes: stay,
      notes,
    };
    const days = trip.days.map((d) => ({
      ...d,
      items: d.items.filter((i) => i.id !== next.id),
    }));
    const target = days.find((d) => d.index === day)!;
    target.items.push(next);
    target.items.sort((a, b) => a.arrival.localeCompare(b.arrival));
    onSave({ ...trip, days });
    onOpenPlan();
  };
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        const values = new FormData(e.currentTarget);
        save(String(values.get("arrival") || arrival));
      }}
    >
      <label>
        名称
        <input
          required
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        安排日期
        <GlassSelect label="安排日期" value={String(day)} options={trip.days.map((d) => ({ value: String(d.index), label: `第 ${d.index} 天` }))} onChange={(value) => setDay(Number(value))} />
      </label>
      <div className="form-columns">
        <label>
          到达时间
          <GlassTimePicker value={arrival} onChange={setArrival} />
        </label>
        <label>
          停留分钟
          <input
            type="number"
            min={10}
            max={1440}
            required
            value={stay}
            onChange={(e) => setStay(Number(e.target.value))}
          />
        </label>
      </div>
      <label>
        备注
        <textarea
          value={notes}
          maxLength={1500}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="想做什么、需要注意什么…"
        />
      </label>
      <button className="primary" disabled={working}>
        保存这一站
        <Check size={18} />
      </button>
      {item && trip.days.some((d) => d.items.some((i) => i.id === item.id)) && (
        <button
          className="text-button danger"
          type="button"
          disabled={working}
          onClick={() =>
            onSave({
              ...trip,
              days: trip.days.map((d) => ({
                ...d,
                items: d.items.filter((i) => i.id !== item.id),
              })),
            })
          }
        >
          <Trash2 size={17} />
          从行程移除
        </button>
      )}
    </form>
  );
}
function ReviewPanel({
  detail,
  user,
  notify,
  onAuth,
  onRefresh,
}: {
  detail: { place: Place; reviews: any[]; rating: number | null };
  user: User;
  notify: (s: string) => void;
  onAuth: () => void;
  onRefresh: () => void;
}) {
  const mine = detail.reviews.find((r) => r.user_id === user.id);
  const [rating, setRating] = useState(mine?.rating || 5);
  const [content, setContent] = useState(mine?.content || "");
  const [busy, setBusy] = useState(false);
  return (
    <div className="review-panel">
      {detail.reviews.length ? (
        <>
          <div className="review-total">
            <strong>{detail.rating?.toFixed(1)}</strong>
            <span>{detail.reviews.length} 条旅行体验</span>
          </div>
          {detail.reviews.map((r) => (
            <article className="review-card" key={r.id}>
              <header>
                <strong>{r.nickname}</strong>
                <span>{"★".repeat(r.rating)}</span>
              </header>
              <p>{r.content}</p>
              <small>{shortDate(r.created_at)}</small>
              {r.user_id === user.id && (
                <button
                  className="text-button"
                  onClick={async () => {
                    await api(`/places/${detail.place.id}/reviews`, {
                      method: "DELETE",
                    });
                    onRefresh();
                  }}
                >
                  删除我的评价
                </button>
              )}
            </article>
          ))}
        </>
      ) : (
        <p className="source-note">还没有旅行评价，期待你的真实体验。</p>
      )}
      {user.username ? (
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await post(`/places/${detail.place.id}/reviews`, {
                rating,
                content,
              });
              notify("你的旅行体验已保存");
              onRefresh();
            } catch (e) {
              notify((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset className="star-rating">
            <legend>你的评分</legend>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                type="button"
                key={n}
                aria-label={`${n} 星`}
                aria-pressed={rating === n}
                className={rating >= n ? "active" : ""}
                onClick={() => setRating(n)}
              >
                ★
              </button>
            ))}
          </fieldset>
          <label>
            旅行体验
            <textarea
              required
              minLength={5}
              maxLength={2000}
              rows={3}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="分享你亲身体验到的风景、交通或建议…"
            />
          </label>
          <button className="primary" disabled={busy}>
            {mine ? "更新我的评价" : "发表评价"}
            <Check size={18} />
          </button>
        </form>
      ) : (
        <button className="secondary full" onClick={onAuth}>
          登录后分享旅行体验
        </button>
      )}
    </div>
  );
}
