import ExpoPagerView from "@expo/ui/community/pager-view";
import { Platform } from "react-native";
import ScrollPagerView from "./scroll-pager-view";

// Expo UI cannot report when paging settles before iOS 18.
export default Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) < 18 ? ScrollPagerView : ExpoPagerView;
