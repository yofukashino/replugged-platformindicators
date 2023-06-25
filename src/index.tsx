/* eslint-disable */
import { User } from "discord-types/general";
import { common, components, Injector, settings, webpack, util } from "replugged";
import { AnyFunction, ObjectExports } from "replugged/dist/types";
import type { ReactElement } from "react";
import platformIndicator from "./Components/PlatformIndicator";
import {
  ClientStatus,
  PlatformIndicatorsSettings,
  PresenceStore,
  SessionStore,
} from "./interfaces";
import "./style.css";
import { addNewSettings, debugLog, forceRerenderElement, logger, resetSettings } from "./utils";

export const inject = new Injector();
const { fluxDispatcher } = common;
const { ErrorBoundary } = components;
const EVENT_NAME = "PRESENCE_UPDATES";

const STATUS_COLOR_REGEX = /case\s\w+\.\w+\.ONLINE:.+case\s\w+\.\w+\.IDLE:/;

export const cfg = await settings.init<
  PlatformIndicatorsSettings,
  keyof typeof PlatformIndicatorsSettings
>("me.puyodead1.PlatformIndicators");

const moduleFindFailed = (name: string): void => logger.error(`Module ${name} not found!`);
let presenceUpdate: (e: {
  type: typeof EVENT_NAME;
  updates: {
    clientStatus: ClientStatus;
    guildId: string;
    status: string;
    user: { id: string };
  }[];
}) => void;

export async function start(): Promise<void> {
  if (cfg.get("resetSettings", PlatformIndicatorsSettings.resetSettings)) resetSettings();

  // add any new settings
  addNewSettings();

  const debug = cfg.get("debug", PlatformIndicatorsSettings.debug);

  debugLog(debug, "Waiting for SessionStore module");
  const SessionStore = await webpack.waitForModule<SessionStore>(
    webpack.filters.byProps("getActiveSession"),
    {
      timeout: 10000,
    },
  );
  if (!SessionStore) return moduleFindFailed("SessionStore");

  debugLog(debug, "Waiting for PresenceStore module");
  const PresenceStore = await webpack.waitForModule<PresenceStore>(
    webpack.filters.byProps("setCurrentUserOnConnectionOpen"),
    {
      timeout: 10000,
    },
  );
  if (!PresenceStore) return moduleFindFailed("PresenceStore");

  debugLog(debug, "Waiting for color constants module");
  const getStatusColorMod = await webpack.waitForModule<Record<string, string>>(
    webpack.filters.bySource(STATUS_COLOR_REGEX),
    {
      timeout: 10000,
    },
  );
  if (!getStatusColorMod) return moduleFindFailed("getStatusColorMod");
  const getStatusColor = webpack.getFunctionBySource<(status: string) => string>(
    getStatusColorMod,
    STATUS_COLOR_REGEX,
  );
  if (!getStatusColor) return moduleFindFailed("getStatusColor");

  debugLog(debug, "Waiting for profile badge classes module");
  const profileBadgeMod = await webpack.waitForModule<Record<string, string>>(
    webpack.filters.byProps("profileBadge24"),
    {
      timeout: 10000,
    },
  );
  if (!profileBadgeMod) return moduleFindFailed("profileBadgeMod");

  debugLog(debug, "Waiting for userStateFromStore module");
  const useStateFromStoreMod = await webpack.waitForModule<ObjectExports>(
    webpack.filters.bySource("useStateFromStore"),
    {
      timeout: 10000,
    },
  );
  if (!useStateFromStoreMod) return moduleFindFailed("useStateFromStoreMod");

  const usfsFnName = webpack.getFunctionKeyBySource(
    useStateFromStoreMod as any,
    "useStateFromStore",
  ) as string;
  if (!usfsFnName) return logger.error("Failed to get function name for useStateFromStoreMod");

  const useStateFromStore = useStateFromStoreMod[usfsFnName] as any;

  const PlatformIndicator = platformIndicator({
    useStateFromStore,
    SessionStore,
    PresenceStore,
    getStatusColor,
    profileBadge24: profileBadgeMod.profileBadge24,
  });

  debugLog(debug, "Waiting for injection point module");

  const messageHeaderModule = await webpack.waitForModule<{
    [key: string]: AnyFunction;
  }>(webpack.filters.bySource(/\w+.withMentionPrefix,\w+=void\s0!==\w/), {
    timeout: 10000,
  });
  if (!messageHeaderModule) return moduleFindFailed("messageHeaderModule");

  const messageHeaderFnName = Object.entries(messageHeaderModule).find(([_, v]) =>
    v.toString()?.match(/.withMentionPrefix/),
  )?.[0];
  if (!messageHeaderFnName) return logger.error("Failed to get message header function name");

  inject.before(messageHeaderModule, messageHeaderFnName, (args, _) => {
    if (!cfg.get("renderInChat")) return args;
    const user = args[0].message.author as User;
    if (args[0].decorations && args[0].decorations["1"] && args[0].message && user) {
      const a = (
        <ErrorBoundary>
          <PlatformIndicator user={user} />
        </ErrorBoundary>
      );
      args[0].decorations[1].push(a);
    }
    return args;
  });

  const userBadClasses = await webpack.waitForProps<Record<string, string>>("containerWithContent");

  const userBadgeModule = await webpack.waitForModule<{
    [key: string]: AnyFunction;
  }>(webpack.filters.bySource("getBadges()"));

  const userBadgeFnName = Object.entries(userBadgeModule).find(
    ([_, v]) => typeof v === "function",
  )?.[0];
  if (!userBadgeFnName) return logger.error("Failed to get user badge function name");

  inject.after(userBadgeModule, userBadgeFnName, ([args], res: ReactElement, _) => {
    if (!cfg.get("renderInProfile")) return res;
    const user = args.user as User;

    const theChildren = res?.props?.children;
    if (!theChildren || !user) return res;
    const a = (
      <ErrorBoundary>
        <PlatformIndicator user={user} />
      </ErrorBoundary>
    );
    res.props.children = [a, ...theChildren];

    if (theChildren.length > 0) {
      if (!res.props.className.includes(userBadClasses?.containerWithContent))
        res.props.className += ` ${userBadClasses?.containerWithContent}`;

      if (!res.props.className.includes("platform-indicator-badge-container"))
        res.props.className += " platform-indicator-badge-container";
    }

    return res;
  });

  const memberListModule = await webpack.waitForModule<{
    [key: string]: {
      $$typeof: symbol;
      compare: null;
      type: AnyFunction;
    };
  }>(webpack.filters.bySource("({canRenderAvatarDecorations:"), {
    timeout: 10000,
  });
  if (!memberListModule) return moduleFindFailed("memberListModule");

  const memberListMemo = Object.entries(memberListModule).find(([_, v]) => v.type)?.[1];
  if (!memberListMemo) return logger.error("Failed to get member list item memo");

  const unpatchMemo = inject.after(
    memberListMemo,
    "type",
    (_args, res: { type: AnyFunction }, _) => {
      inject.after(
        res.type.prototype,
        "renderDecorators",
        (args, res, instance: { props?: { user: User } }) => {
          if (!cfg.get("renderInMemberList")) return res;

          const user = instance?.props?.user;
          if (Array.isArray(res?.props?.children) && user) {
            const a = (
              <ErrorBoundary>
                <PlatformIndicator user={user} />
              </ErrorBoundary>
            );
            res.props.children.push(a);
          }
          return res;
        },
      );

      unpatchMemo();
    },
  );

  const directMessageListModule = await webpack.waitForModule<Record<string, AnyFunction>>(
    webpack.filters.bySource(".interactiveSystemDM"),
    {
      timeout: 10000,
    },
  );
  if (!directMessageListModule) return moduleFindFailed("directMessageListModule ");

  const directMessageListFnName = Object.entries(directMessageListModule).find(([_, v]) =>
    v.toString()?.includes(".getAnyStreamForUser("),
  )?.[0];
  if (!directMessageListFnName) return logger.error("Failed to get message header function name");
  const unpatchConstructor = inject.after(
    directMessageListModule,
    directMessageListFnName,
    (_args, res: { type: AnyFunction }, _) => {
      inject.after(
        res.type.prototype,
        "render",
        (
          _args,
          res: { props: { children: AnyFunction } },
          instance: { props?: { user: User } },
        ) => {
          const user = instance?.props?.user;
          if (!cfg.get("renderInDirectMessageList") || !user) return res;
          inject.after(res.props, "children", (_args, res: ReactElement, _) => {
            const { findInReactTree } = util as unknown as {
              findInReactTree: (
                tree: ReactElement,
                filter: AnyFunction,
                maxRecursions?: number,
              ) => ReactElement;
            };
            const container = findInReactTree(
              res,
              (c) => c?.props?.avatar && c?.props?.name && c?.props?.subText,
            );
            if (!container) return res;
            const a = (
              <ErrorBoundary>
                <PlatformIndicator user={user} />
              </ErrorBoundary>
            );
            if (Array.isArray(container.props.decorators)) {
              container?.props?.decorators.push(a);
            } else if (container.props.decorators === null) {
              container.props.decorators = [a];
            } else {
              container.props.decorators = [...Array.from(container.props.decorators), a];
            }
            return res;
          });
          return res;
        },
      );
      unpatchConstructor();
    },
  );
  await util.waitFor("[class^=layout-]");
  forceRerenderElement("[class^=privateChannels-]");
}

export function stop(): void {
  inject.uninjectAll();
  fluxDispatcher.unsubscribe(EVENT_NAME, presenceUpdate as any);
  logger.log("Unsubscribed from Presence updates");
}

export { Settings } from "./Components/Settings";
