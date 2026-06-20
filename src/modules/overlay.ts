import { MenuitemOptions } from "zotero-plugin-toolkit/dist/managers/menu";
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { patch as $patch$, unpatch as $unpatch$ } from "../utils/patcher";
import {
	getPref,
	setPref,
	clearPref,
	initialiseDefaultPref,
	getPrefGlobalName,
} from "../utils/prefs";
import {
	getItemExtraProperty,
	setItemExtraProperty,
	clearItemExtraProperty,
	removeFieldValueFromExtraData,
} from "../utils/extraField";
import {
	parseProgress,
	formatProgress,
	detectContentEndPage,
} from "../utils/readingProgress";

const READ_STATUS_COLUMN_ID = "readstatus";
const READ_STATUS_EXTRA_FIELD = "Read_Status";
const READ_DATE_EXTRA_FIELD = "Read_Status_Date";
const READ_PROGRESS_EXTRA_FIELD = "Read_Progress"; // "highwater/total" (1-indexed pages)
const READ_SCROLL_PROGRESS_EXTRA_FIELD = "Read_Scroll_Progress"; // scroll % (0-100) for HTML
const READ_LAST_OPEN_EXTRA_FIELD = "Read_Last_Open"; // ISO date of last PDF open

export const DEFAULT_STATUS_NAMES = [
	"New",
	"To Read",
	"In Progress",
	"Read",
	"Not Reading",
];
export const DEFAULT_STATUS_ICONS = ["⭐", "📙", "📖", "📗", "📕"];

export const DEFAULT_STATUS_CHANGE_FROM = ["New", "To Read"];
export const DEFAULT_STATUS_CHANGE_TO = ["In Progress", "In Progress"];

export const SHOW_ICONS_PREF = "show-icons"; // deprecated
export const READ_STATUS_FORMAT_PREF = "read-status-format";
export const READ_STATUS_FORMAT_HEADER_SHOW_ICON =
	"readstatuscolumn-format-header-showicon";
export const LABEL_NEW_ITEMS_PREF = "label-new-items";
export const LABEL_NEW_ITEMS_PREF_DISABLED = "|none|";
export const LABEL_ITEMS_WHEN_OPENING_FILE_PREF =
	"label-items-when-opening-file";
export const ENABLE_KEYBOARD_SHORTCUTS_PREF = "enable-keyboard-shortcuts";
export const STATUS_NAME_AND_ICON_LIST_PREF = "statuses-and-icons-list";
export const STATUS_CHANGE_ON_OPEN_ITEM_LIST_PREF =
	"status-change-on-open-item-list";
export const AUTO_COMPLETE_PREF = "auto-complete-on-finish";
export const COMPLETION_THRESHOLD_PREF = "completion-threshold"; // integer 0–100
export const COMPLETION_STATUS_PREF = "completion-status"; // status name to set on finish
export const NEW_STATUS_EXPIRY_DAYS_PREF = "new-status-expiry-days"; // 0 = disabled
export const HTML_DWELL_SECONDS_PREF = "html-completion-dwell-seconds"; // seconds to stay at threshold

enum ReadStatusFormat {
	ShowBoth = 0,
	ShowText = 1,
	ShowIcon = 2,
}

function getItemReadStatus(item: Zotero.Item) {
	const statusField = getItemExtraProperty(item, READ_STATUS_EXTRA_FIELD);
	return statusField.length == 1 ? statusField[0] : "";
}

function setItemReadStatus(item: Zotero.Item, statusName: string) {
	setItemExtraProperty(item, READ_STATUS_EXTRA_FIELD, statusName);
	setItemExtraProperty(
		item,
		READ_DATE_EXTRA_FIELD,
		new Date(Date.now()).toISOString(),
	);
	void item.saveTx();
}

function setItemsReadStatus(items: Zotero.Item[], statusName: string) {
	for (const item of items) {
		setItemReadStatus(item, statusName);
	}
}

function setSelectedItemsReadStatus(statusName: string) {
	setItemsReadStatus(getSelectedItems(), statusName);
}

function clearSelectedItemsReadStatus() {
	const items = getSelectedItems();
	for (const item of items) {
		clearItemExtraProperty(item, READ_STATUS_EXTRA_FIELD);
		clearItemExtraProperty(item, READ_DATE_EXTRA_FIELD);
		void item.saveTx();
	}
}

/**
 * Return selected regular items
 */
function getSelectedItems() {
	return ZoteroPane.getSelectedItems().filter((item) => item.isRegularItem());
}

export const FORBIDDEN_PREF_STRING_CHARACTERS = new Set(":;|");

export async function initializeUntrackedItems(defaultStatus: string): Promise<number> {
	const allItems = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
	let count = 0;
	for (const item of allItems) {
		if (!item.isRegularItem()) continue;
		if (getItemReadStatus(item)) continue;
		setItemReadStatus(item, defaultStatus);
		count++;
	}
	return count;
}

export function prefStringToList(prefString: string) {
	const [statusString, iconString] = prefString.split("|");
	return [statusString.split(";"), iconString.split(";")];
}

export function listToPrefString(stringList: string[], iconList: string[]) {
	return stringList.join(";") + "|" + iconList.join(";");
}

export default class ZoteroReadingList {
	itemAddedListenerID?: string;
	fileOpenedListenerID?: string;
	itemTreeReadStatusColumnId?: string | false;
	preferenceUpdateObservers?: symbol[];
	statusNames: string[];
	statusIcons: string[];

	// Reading progress tracking
	private readerTrackerListeners: Map<
		string,
		{
			pdfApp: _ZoteroTypes.Reader.PDFViewerApplication;
			listener: (event: { pageNumber: number }) => void;
		}
	> = new Map();
	// Last seen page per reader instance, for sequential-advance detection
	private readerPreviousPage: Map<string, number> = new Map();
	// contentEndPage per attachment item ID, so we can check completion on reader close
	private contentEndPageCache: Map<number, number | null> = new Map();
	// Last page the reader was on (updated on every pagechanging, regardless of delta)
	// Used by the close handler to detect "jumped to end then closed"
	private readerLastSeenPage: Map<number, number> = new Map();
	// Snapshot (HTML) tracking
	private snapshotListeners: Map<
		string,
		{ iframeWin: Window; listener: () => void }
	> = new Map();
	private snapshotDwellTimers: Map<string, ReturnType<typeof setTimeout>> =
		new Map();
	// HWM scroll % (0-100) per attachment ID — persists after reader closes for close handler
	private snapshotScrollHwm: Map<number, number> = new Map();
	private saveDebounceTimers: Map<number, ReturnType<typeof setTimeout>> =
		new Map();
	private isReaderTrackerPatched = false;

	// Maximum page advance treated as sequential reading vs. a navigation jump.
	// 15 tolerates fast scroll wheel / arrow-key bursts that skip pages; genuine
	// footnote links (usually 50–200 pages away) are still filtered out.
	private static readonly MAX_READING_ADVANCE = 15;

	constructor() {
		this.initialiseDefaultPreferences();
		[this.statusNames, this.statusIcons] = prefStringToList(
			getPref(STATUS_NAME_AND_ICON_LIST_PREF)! as string,
		);

		this.addReadStatusColumn();
		this.addPreferencesMenu();
		this.addRightClickMenuPopup();

		if (getPref(ENABLE_KEYBOARD_SHORTCUTS_PREF)) {
			this.addKeyboardShortcutListener();
		}
		if (getPref(LABEL_NEW_ITEMS_PREF) != LABEL_NEW_ITEMS_PREF_DISABLED) {
			this.addNewItemLabeller();
		}
		// Always register the file listener — it handles both status-on-open
		// (guarded by LABEL_ITEMS_WHEN_OPENING_FILE_PREF internally) and
		// auto-complete-on-close (guarded by AUTO_COMPLETE_PREF internally).
		this.addFileOpenedListener();

		this.addPreferenceUpdateObservers();
		this.removeReadStatusFromExports();
		this.addProgressTracker();
		void this.sweepExpiredNewStatus();
	}

	public unload() {
		this.removeReadStatusColumn();
		this.removePreferenceMenu();
		this.removeRightClickMenu();
		this.removeKeyboardShortcutListener();
		this.removeNewItemLabeller();
		this.removeFileOpenedListener();
		this.removePreferenceUpdateObservers();
		this.unpatchExportFunction();
		this.removeProgressTracker();
	}

	initialiseDefaultPreferences() {
		// for migrating from old format pref (show icon or not) to new format pref (show both, text, or icon)
		// show icon -> show both
		// don't show icon -> show text
		// otherwise, default is show both
		const oldReadStatusColumnFormatPref_showIcons =
			getPref(SHOW_ICONS_PREF);
		if (
			typeof oldReadStatusColumnFormatPref_showIcons == "boolean" &&
			!oldReadStatusColumnFormatPref_showIcons
		) {
			initialiseDefaultPref(
				READ_STATUS_FORMAT_PREF,
				ReadStatusFormat.ShowText,
			);
		} else {
			initialiseDefaultPref(
				READ_STATUS_FORMAT_PREF,
				ReadStatusFormat.ShowBoth,
			);
		}
		initialiseDefaultPref(READ_STATUS_FORMAT_HEADER_SHOW_ICON, false);
		initialiseDefaultPref(ENABLE_KEYBOARD_SHORTCUTS_PREF, true);
		initialiseDefaultPref(LABEL_ITEMS_WHEN_OPENING_FILE_PREF, false);
		initialiseDefaultPref(
			STATUS_NAME_AND_ICON_LIST_PREF,
			listToPrefString(DEFAULT_STATUS_NAMES, DEFAULT_STATUS_ICONS),
		);
		initialiseDefaultPref(
			STATUS_CHANGE_ON_OPEN_ITEM_LIST_PREF,
			listToPrefString(
				DEFAULT_STATUS_CHANGE_FROM,
				DEFAULT_STATUS_CHANGE_TO,
			),
		);
		initialiseDefaultPref(AUTO_COMPLETE_PREF, true);
		initialiseDefaultPref(COMPLETION_THRESHOLD_PREF, 90);
		initialiseDefaultPref(COMPLETION_STATUS_PREF, "");
		initialiseDefaultPref(NEW_STATUS_EXPIRY_DAYS_PREF, 7);
		initialiseDefaultPref(HTML_DWELL_SECONDS_PREF, 15);

		// for migrating from old label new items pref (true or false) to new format pref (disabled or choose read status to use)
		// true -> automatically label as first read status
		// false -> disabled
		const oldLabelNewItemsPref = getPref(LABEL_NEW_ITEMS_PREF);
		if (typeof oldLabelNewItemsPref == "boolean") {
			// need to clear then set Pref when changing type from bool to string
			clearPref(LABEL_NEW_ITEMS_PREF);
			if (oldLabelNewItemsPref) {
				setPref(
					LABEL_NEW_ITEMS_PREF,
					prefStringToList(
						getPref(STATUS_NAME_AND_ICON_LIST_PREF)! as string,
					)[0][0],
				);
			} else {
				setPref(LABEL_NEW_ITEMS_PREF, LABEL_NEW_ITEMS_PREF_DISABLED);
			}
		} else {
			initialiseDefaultPref(
				LABEL_NEW_ITEMS_PREF,
				LABEL_NEW_ITEMS_PREF_DISABLED,
			);
		}
	}

	addPreferenceUpdateObservers() {
		this.preferenceUpdateObservers = [
			Zotero.Prefs.registerObserver(
				getPrefGlobalName(ENABLE_KEYBOARD_SHORTCUTS_PREF),
				(value: boolean) => {
					if (value) {
						this.addKeyboardShortcutListener();
					} else {
						this.removeKeyboardShortcutListener();
					}
				},
				true,
			),
			Zotero.Prefs.registerObserver(
				getPrefGlobalName(LABEL_NEW_ITEMS_PREF),
				(value: string) => {
					if (value == LABEL_NEW_ITEMS_PREF_DISABLED) {
						this.removeNewItemLabeller();
					} else if (typeof this.itemAddedListenerID == "undefined") {
						this.addNewItemLabeller();
					}
				},
				true,
			),
			Zotero.Prefs.registerObserver(
				getPrefGlobalName(LABEL_ITEMS_WHEN_OPENING_FILE_PREF),
				(_value: boolean) => {
					// The file listener is always registered; the open handler
					// reads this pref at call time, so no re-registration needed.
				},
				true,
			),
			// refresh read status column on format change
			Zotero.Prefs.registerObserver(
				getPrefGlobalName(READ_STATUS_FORMAT_PREF),
				(value: boolean) => {
					this.removeReadStatusColumn();
					this.removeRightClickMenu();
					this.addReadStatusColumn();
					this.addRightClickMenuPopup();
				},
				true,
			),
			Zotero.Prefs.registerObserver(
				getPrefGlobalName(READ_STATUS_FORMAT_HEADER_SHOW_ICON),
				(value: boolean) => {
					this.removeReadStatusColumn();
					this.addReadStatusColumn();
				},
				true,
			),
			Zotero.Prefs.registerObserver(
				getPrefGlobalName(STATUS_NAME_AND_ICON_LIST_PREF),
				(value: string) => {
					[this.statusNames, this.statusIcons] =
						prefStringToList(value);
					this.removeRightClickMenu();
					this.addRightClickMenuPopup();
					this.removeKeyboardShortcutListener();
					this.addKeyboardShortcutListener();
					this.removeReadStatusColumn();
					this.addReadStatusColumn();
				},
				true,
			),
		];
	}

	removePreferenceUpdateObservers() {
		if (this.preferenceUpdateObservers) {
			for (const preferenceUpdateObserverSymbol of this
				.preferenceUpdateObservers) {
				Zotero.Prefs.unregisterObserver(preferenceUpdateObserverSymbol);
			}
			this.preferenceUpdateObservers = undefined;
		}
	}

	addReadStatusColumn() {
		const formatStatusName = (statusName: string) =>
			this.formatStatusName(statusName);
		this.itemTreeReadStatusColumnId = Zotero.ItemTreeManager.registerColumn(
			{
				dataKey: `${config.addonID.replaceAll("-", "_").replaceAll("@", "_at_").replaceAll(".", "_")}_${READ_STATUS_COLUMN_ID}`,
				label: getString("read-status"),
				// If we just want to show the icon, overwrite the label with htmlLabel (#40)
				htmlLabel: getPref(READ_STATUS_FORMAT_HEADER_SHOW_ICON)
					? `<span class="icon icon-css icon-16" style="background: url(chrome://${config.addonRef}/content/icons/favicon.png) content-box no-repeat center/contain;" />`
					: undefined,
				pluginID: "", //config.addonID,
				dataProvider: (item: Zotero.Item, dataKey: string) => {
					return item.isRegularItem() ? getItemReadStatus(item) : "";
				},
				// if we put the icon in the dataprovider, it only gets updated when the read status changes
				// putting the icon in the render function updates when the row is clicked or column is sorted
				renderCell: function (
					index: number,
					data: string,
					column: { className: string },
				) {
					const text = document.createElementNS(
						"http://www.w3.org/1999/xhtml",
						"span",
					);
					text.className = "cell-text";
					text.innerText = formatStatusName(data);

					const cell = document.createElementNS(
						"http://www.w3.org/1999/xhtml",
						"span",
					);
					cell.className = `cell ${column.className}`;
					cell.append(text);

					return cell;
				},
				zoteroPersist: ["width", "hidden", "sortDirection"],
			},
		);
	}

	/**
	 * Format name of status to localise text and include icon if enabled.
	 * @param {string} statusName - The name of the status.
	 * @returns {String} values - Name of the status, possibly prefixed with the corresponding icon.
	 */
	formatStatusName(statusName: string): string {
		switch (getPref(READ_STATUS_FORMAT_PREF) as ReadStatusFormat) {
			case ReadStatusFormat.ShowBoth: {
				const statusIndex = this.statusNames.indexOf(statusName);
				return statusIndex > -1
					? `${this.statusIcons[statusIndex]} ${statusName}`
					: statusName;
			}
			case ReadStatusFormat.ShowText: {
				return statusName;
			}
			case ReadStatusFormat.ShowIcon: {
				const statusIndex = this.statusNames.indexOf(statusName);
				return statusIndex > -1
					? `${this.statusIcons[statusIndex]}`
					: statusName;
			}
		}
	}

	removeReadStatusColumn() {
		if (this.itemTreeReadStatusColumnId) {
			Zotero.ItemTreeManager.unregisterColumn(
				this.itemTreeReadStatusColumnId,
			);
			this.itemTreeReadStatusColumnId = undefined;
		}
	}

	addPreferencesMenu() {
		const prefOptions = {
			pluginID: config.addonID,
			src: rootURI + "chrome/content/preferences.xhtml",
			label: getString("prefs-title"),
			image: `chrome://${config.addonRef}/content/icons/favicon.png`,
			defaultXUL: true,
		};
		void Zotero.PreferencePanes.register(prefOptions);
	}

	removePreferenceMenu() {
		Zotero.PreferencePanes.unregister(config.addonID);
	}

	addRightClickMenuPopup() {
		ztoolkit.Menu.register("item", {
			id: "zotero-reading-list-right-click-item-menu",
			tag: "menu",
			label: getString("menupopup-label"),
			children: [
				{
					tag: "menuitem",
					label: getString("status-none"),
					commandListener: (event) =>
						void clearSelectedItemsReadStatus(),
				} as MenuitemOptions,
			].concat(
				this.statusNames.map((status_name: string) => {
					return {
						tag: "menuitem",
						label: this.formatStatusName(status_name),
						commandListener: (event) =>
							setSelectedItemsReadStatus(status_name),
					};
				}),
			),
			getVisibility: (element, event) => {
				return getSelectedItems().length > 0;
			},
		});
	}

	removeRightClickMenu() {
		ztoolkit.Menu.unregister("zotero-reading-list-right-click-item-menu");
	}

	addNewItemLabeller() {
		const addItemHandler = (
			action: _ZoteroTypes.Notifier.Event,
			type: _ZoteroTypes.Notifier.Type,
			ids: string[] | number[],
			extraData: _ZoteroTypes.anyObj,
		) => {
			if (action == "add") {
				const items = Zotero.Items.get(ids).filter((item) =>
					item.isRegularItem(),
				);

				setItemsReadStatus(
					items,
					getPref(LABEL_NEW_ITEMS_PREF)! as string,
				);
			}
		};

		this.itemAddedListenerID = Zotero.Notifier.registerObserver(
			{
				notify(...args) {
					// eslint-disable-next-line prefer-spread
					addItemHandler.apply(null, args);
				},
			},
			["item"],
			"zotero-reading-list",
			1,
		);
	}

	removeNewItemLabeller() {
		if (this.itemAddedListenerID) {
			Zotero.Notifier.unregisterObserver(this.itemAddedListenerID);
			this.itemAddedListenerID = undefined;
		}
	}

	addFileOpenedListener() {
		const fileOpenHandler = (
			action: string,
			type: string,
			ids: string[] | number[],
			extraData: any,
		) => {
			if (action == "open" && getPref(LABEL_ITEMS_WHEN_OPENING_FILE_PREF)) {
				const items = Zotero.Items.getTopLevel(
					Zotero.Items.get(ids as number[]),
				);

				const [statusFrom, statusTo] = prefStringToList(
					getPref(STATUS_CHANGE_ON_OPEN_ITEM_LIST_PREF) as string,
				);

				for (const item of items) {
					const itemReadStatusIndex = statusFrom.indexOf(
						getItemReadStatus(item),
					);
					if (itemReadStatusIndex > -1) {
						setItemReadStatus(item, statusTo[itemReadStatusIndex]);
					}
				}
			}

			if (action == "close") {
				if (!getPref(AUTO_COMPLETE_PREF)) return;
				const attachmentItems = Zotero.Items.get(ids as number[]);
				for (const attachment of attachmentItems) {
					const parentItem = attachment.parentItem ?? attachment;

					// ── PDF completion check ──────────────────────────────
					const progressStrs = getItemExtraProperty(
						parentItem,
						READ_PROGRESS_EXTRA_FIELD,
					);
					if (progressStrs.length === 1) {
						const progress = parseProgress(progressStrs[0]);
						if (progress) {
							const contentEndPage =
								this.contentEndPageCache.get(attachment.id) ??
								null;
							const threshold =
								((getPref(COMPLETION_THRESHOLD_PREF) as number) ??
									90) / 100;
							const completionPage =
								contentEndPage ??
								Math.ceil(progress.totalPages * threshold);
							const lastSeen =
								this.readerLastSeenPage.get(attachment.id) ?? 0;
							const effectivePage = Math.max(
								progress.highwaterPage,
								lastSeen,
							);
							if (effectivePage >= completionPage) {
								const completionStatus =
									this.resolveCompletionStatus();
								if (
									getItemReadStatus(parentItem) !==
									completionStatus
								) {
									setItemReadStatus(
										parentItem,
										completionStatus,
									);
								}
							}
							continue; // handled as PDF
						}
					}

					// ── Snapshot (HTML) completion check ─────────────────
					// On close, if HWM scroll % was at/past the threshold, count it.
					const scrollHwm = this.snapshotScrollHwm.get(attachment.id);
					if (scrollHwm !== undefined) {
						const threshold =
							(getPref(COMPLETION_THRESHOLD_PREF) as number) ?? 90;
						if (scrollHwm >= threshold) {
							const completionStatus =
								this.resolveCompletionStatus();
							if (
								getItemReadStatus(parentItem) !== completionStatus
							) {
								setItemReadStatus(parentItem, completionStatus);
							}
						}
					}
				}
			}
		};

		this.fileOpenedListenerID = Zotero.Notifier.registerObserver(
			{
				notify(...args) {
					// eslint-disable-next-line prefer-spread
					fileOpenHandler.apply(null, args);
				},
			},
			["file"],
			"zotero-reading-list",
			1,
		);
	}

	removeFileOpenedListener() {
		if (this.fileOpenedListenerID) {
			Zotero.Notifier.unregisterObserver(this.fileOpenedListenerID);
			this.fileOpenedListenerID = undefined;
		}
	}

	keyboardEventHandler = (keyboardEvent: KeyboardEvent) => {
		// Check modifiers - want Alt+{1,2,3,4,5} to label the currently selected items
		// Or Alt+0 to clear the current read status
		// Need to use keyboard event `code` instead of `key` to support different keyboard
		// layouts, as well as fix problems with Mac #9 #53
		const possibleKeyCombinations: Map<string, number> = new Map();
		for (let num = 0; num < this.statusNames.length; num++) {
			possibleKeyCombinations.set(`Digit${num + 1}`, num);
			possibleKeyCombinations.set(`Numpad${num + 1}`, num);
		}
		const clearStatusKeyCombinations = ["Digit0", "Numpad0"];
		if (
			!keyboardEvent.ctrlKey &&
			!keyboardEvent.shiftKey &&
			keyboardEvent.altKey
		) {
			if (possibleKeyCombinations.has(keyboardEvent.code)) {
				const selectedStatus =
					this.statusNames[
						possibleKeyCombinations.get(keyboardEvent.code)!
					];
				void setSelectedItemsReadStatus(selectedStatus);
			} else if (
				clearStatusKeyCombinations.includes(keyboardEvent.code)
			) {
				void clearSelectedItemsReadStatus();
			}
		}
	};

	addKeyboardShortcutListener() {
		// disable Zotero's column sorting (also uses Alt+Num shortcut keys) #30
		document
			.getElementById("sortSubmenuKeys")
			?.setAttribute("disabled", "true");
		// different approach compared to Zutilo https://github.com/wshanks/Zutilo/issues/71#issuecomment-360986808
		document.addEventListener("keydown", this.keyboardEventHandler);
	}

	removeKeyboardShortcutListener() {
		document.removeEventListener("keydown", this.keyboardEventHandler);
		// reenable Zotero's column sorting
		document
			.getElementById("sortSubmenuKeys")
			?.setAttribute("disabled", "false");
	}

	removeReadStatusFromExports() {
		// need to specify that `this` is an Object (ie. it's Zotero.Utilities.Internal) for TS to be happy
		$patch$(
			Zotero.Utilities.Internal,
			"itemToExportFormat",
			// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
			(original: Function) =>
				function Zotero_Utilities_Internal_itemToExportFormat(
					this: object,
					zoteroItem: Zotero.Item,
					_legacy: any,
					_skipChildItems: any,
				) {
					// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, prefer-rest-params
					const serializedItem = original.apply(this, arguments);
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
					if (serializedItem.extra) {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
						let extraText = serializedItem.extra as string;
						extraText = removeFieldValueFromExtraData(
							extraText,
							READ_STATUS_EXTRA_FIELD,
						);
						extraText = removeFieldValueFromExtraData(
							extraText,
							READ_DATE_EXTRA_FIELD,
						);
						extraText = removeFieldValueFromExtraData(
							extraText,
							READ_PROGRESS_EXTRA_FIELD,
						);
						extraText = removeFieldValueFromExtraData(
							extraText,
							READ_SCROLL_PROGRESS_EXTRA_FIELD,
						);
						extraText = removeFieldValueFromExtraData(
							extraText,
							READ_LAST_OPEN_EXTRA_FIELD,
						);
						// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
						serializedItem.extra = extraText;
					}
					// eslint-disable-next-line @typescript-eslint/no-unsafe-return
					return serializedItem;
				},
		);
	}

	unpatchExportFunction() {
		$unpatch$(Zotero.Utilities.Internal, "itemToExportFormat");
	}

	// ── New-status expiry ─────────────────────────────────────────────────

	async sweepExpiredNewStatus() {
		const expiryDays = (getPref(NEW_STATUS_EXPIRY_DAYS_PREF) as number) ?? 7;
		if (expiryDays <= 0) return;

		const newStatus = this.statusNames[0];
		if (!newStatus) return;

		// The status to transition to after expiry — second status if available
		const expiredStatus = this.statusNames[1] ?? null;

		const expiryMs = expiryDays * 24 * 60 * 60 * 1000;
		const cutoff = Date.now() - expiryMs;

		const allItems = await Zotero.Items.getAll(
			Zotero.Libraries.userLibraryID,
		);

		for (const item of allItems) {
			if (!item.isRegularItem()) continue;
			if (getItemReadStatus(item) !== newStatus) continue;

			const dateStrs = getItemExtraProperty(item, READ_DATE_EXTRA_FIELD);
			if (dateStrs.length !== 1) continue;

			const labeledAt = new Date(dateStrs[0]).getTime();
			if (isNaN(labeledAt) || labeledAt > cutoff) continue;

			// Expired — move to next status or clear
			if (expiredStatus) {
				setItemReadStatus(item, expiredStatus);
			} else {
				clearItemExtraProperty(item, READ_STATUS_EXTRA_FIELD);
				clearItemExtraProperty(item, READ_DATE_EXTRA_FIELD);
				void item.saveTx();
			}
		}
	}

	// ── Reading progress tracking ──────────────────────────────────────────

	addProgressTracker() {
		const self = this;

		// Patch any readers already open (e.g. on plugin reload during development)
		for (const reader of Zotero.Reader._readers) {
			void self.setupReaderTracking(reader);
		}

		// Intercept future reader opens
		$patch$(
			Zotero.Reader,
			"open",
			(original) =>
				async function (
					this: object,
					itemID: number,
					location?: _ZoteroTypes.Reader.Location,
					options?: _ZoteroTypes.Reader.OpenOptions,
				) {
					const result = (await original.call(
						this,
						itemID,
						location,
						options,
					)) as _ZoteroTypes.ReaderInstance | undefined;
					const reader =
						result ??
						Zotero.Reader._readers.find((r) => r.itemID === itemID);
					if (reader) void self.setupReaderTracking(reader);
					return result;
				},
		);
		this.isReaderTrackerPatched = true;
	}

	removeProgressTracker() {
		// Remove eventBus listeners from each tracked reader
		for (const { pdfApp, listener } of this.readerTrackerListeners.values()) {
			pdfApp.eventBus?.off("pagechanging", listener);
		}
		this.readerTrackerListeners.clear();
		this.readerPreviousPage.clear();
		this.contentEndPageCache.clear();
		this.readerLastSeenPage.clear();

		// Clean up snapshot (HTML) listeners and dwell timers
		for (const { iframeWin, listener } of this.snapshotListeners.values()) {
			iframeWin.removeEventListener("scroll", listener);
		}
		this.snapshotListeners.clear();
		for (const timer of this.snapshotDwellTimers.values()) {
			clearTimeout(timer);
		}
		this.snapshotDwellTimers.clear();
		this.snapshotScrollHwm.clear();

		// Flush any pending debounced saves
		for (const timer of this.saveDebounceTimers.values()) {
			clearTimeout(timer);
		}
		this.saveDebounceTimers.clear();

		if (this.isReaderTrackerPatched) {
			$unpatch$(Zotero.Reader, "open");
			this.isReaderTrackerPatched = false;
		}
	}

	private async setupReaderTracking(reader: _ZoteroTypes.ReaderInstance) {
		if (reader.type === "snapshot") {
			void this.setupSnapshotTracking(
				reader as _ZoteroTypes.ReaderInstance<"snapshot">,
			);
			return;
		}
		if (reader.type !== "pdf") return;
		if (this.readerTrackerListeners.has(reader._instanceID)) return;

		try {
			await reader._initPromise;

			const pdfView =
				reader._primaryView as _ZoteroTypes.Reader.PDFView;
			await pdfView.initializedPromise;

			const pdfApp = pdfView._iframeWindow?.PDFViewerApplication;
			if (!pdfApp) return;

			await pdfApp.initializedPromise;

			const totalPages = pdfApp.pagesCount;
			if (!totalPages) return;

			const parentItem = reader._item.parentItem ?? reader._item;

			// Record that this item was opened now
			setItemExtraProperty(
				parentItem,
				READ_LAST_OPEN_EXTRA_FIELD,
				new Date().toISOString(),
			);
			this.debouncedSave(parentItem);

			// Detect where back matter begins (references, appendix, etc.)
			const contentEndPage = await detectContentEndPage(pdfApp);

			// Cache so the file-close handler can re-check completion without the PDF open
			this.contentEndPageCache.set(reader._item.id, contentEndPage);

			// Seed previous-page with the reader's current position
			const startPage = pdfApp.page ?? 1;
			this.readerPreviousPage.set(reader._instanceID, startPage);

			// Listen to pdf.js page-change events
			const instanceID = reader._instanceID;
			const attachmentID = reader._item.id;
			const listener = ({ pageNumber }: { pageNumber: number }) => {
				const prev = this.readerPreviousPage.get(instanceID) ?? pageNumber;
				this.readerPreviousPage.set(instanceID, pageNumber);
				// Always track last seen page regardless of delta (used by close handler)
				this.readerLastSeenPage.set(attachmentID, pageNumber);
				void this.onPageChange(
					parentItem,
					pageNumber,
					prev,
					totalPages,
					contentEndPage,
				);
			};

			pdfApp.eventBus?.on("pagechanging", listener);
			this.readerTrackerListeners.set(reader._instanceID, {
				pdfApp,
				listener,
			});
		} catch (e) {
			ztoolkit.log(`[ReadingProgress] setup error: ${e}`);
		}
	}

	private async setupSnapshotTracking(
		reader: _ZoteroTypes.ReaderInstance<"snapshot">,
	) {
		if (this.snapshotListeners.has(reader._instanceID)) return;

		try {
			await reader._initPromise;

			const snapshotView = reader._primaryView;
			await snapshotView.initializedPromise;

			// _iframeWindow is protected on DOMView; access via cast
			const iframeWin = (snapshotView as any)
				._iframeWindow as (Window & typeof globalThis) | undefined;
			if (!iframeWin) return;

			const parentItem = reader._item.parentItem ?? reader._item;
			const attachmentID = reader._item.id;
			const instanceID = reader._instanceID;

			// Record open date
			setItemExtraProperty(
				parentItem,
				READ_LAST_OPEN_EXTRA_FIELD,
				new Date().toISOString(),
			);
			this.debouncedSave(parentItem);

			const getScrollPct = (): number => {
				const doc = iframeWin.document;
				const scrollable =
					doc.documentElement.scrollHeight - iframeWin.innerHeight;
				if (scrollable <= 0) return 100;
				return Math.min(
					100,
					Math.round((iframeWin.scrollY / scrollable) * 100),
				);
			};

			const threshold =
				(getPref(COMPLETION_THRESHOLD_PREF) as number) ?? 90;

			const listener = () => {
				const pct = getScrollPct();

				// Update HWM
				const prevHwm = this.snapshotScrollHwm.get(attachmentID) ?? 0;
				if (pct > prevHwm) {
					this.snapshotScrollHwm.set(attachmentID, pct);
					setItemExtraProperty(
						parentItem,
						READ_SCROLL_PROGRESS_EXTRA_FIELD,
						String(pct),
					);
					this.debouncedSave(parentItem);
				}

				if (!getPref(AUTO_COMPLETE_PREF)) return;

				if (pct >= threshold) {
					// At or past threshold — start dwell timer if not already running
					if (!this.snapshotDwellTimers.has(instanceID)) {
						const dwellMs =
							((getPref(HTML_DWELL_SECONDS_PREF) as number) ?? 15) *
							1000;
						this.snapshotDwellTimers.set(
							instanceID,
							setTimeout(() => {
								this.snapshotDwellTimers.delete(instanceID);
								const completionStatus =
									this.resolveCompletionStatus();
								if (
									getItemReadStatus(parentItem) !==
									completionStatus
								) {
									setItemReadStatus(parentItem, completionStatus);
								}
							}, dwellMs),
						);
					}
				} else {
					// Scrolled back above threshold — cancel dwell timer
					const timer = this.snapshotDwellTimers.get(instanceID);
					if (timer !== undefined) {
						clearTimeout(timer);
						this.snapshotDwellTimers.delete(instanceID);
					}
				}
			};

			iframeWin.addEventListener("scroll", listener, { passive: true });
			this.snapshotListeners.set(instanceID, { iframeWin, listener });
		} catch (e) {
			ztoolkit.log(`[ReadingProgress] snapshot setup error: ${e}`);
		}
	}

	private async onPageChange(
		parentItem: Zotero.Item,
		pageNumber: number, // 1-indexed, current page
		previousPage: number, // 1-indexed, page before this event
		totalPages: number,
		contentEndPage: number | null, // 1-indexed page where back matter starts, or null
	) {
		const delta = pageNumber - previousPage;

		// Only count as reading progress when advancing sequentially.
		// Large positive jumps (footnote links, TOC clicks) and backward jumps
		// (going back to check something) are navigation, not reading.
		if (delta <= 0 || delta > ZoteroReadingList.MAX_READING_ADVANCE) return;

		const progressStrs = getItemExtraProperty(
			parentItem,
			READ_PROGRESS_EXTRA_FIELD,
		);
		const currentProgress =
			progressStrs.length === 1 ? parseProgress(progressStrs[0]) : null;
		const currentHwm = currentProgress?.highwaterPage ?? 0;

		if (pageNumber <= currentHwm) return; // already recorded this ground

		setItemExtraProperty(
			parentItem,
			READ_PROGRESS_EXTRA_FIELD,
			formatProgress(pageNumber, totalPages),
		);
		this.debouncedSave(parentItem);

		if (!getPref(AUTO_COMPLETE_PREF)) return;

		const threshold =
			((getPref(COMPLETION_THRESHOLD_PREF) as number) ?? 90) / 100;
		const completionPage =
			contentEndPage ?? Math.ceil(totalPages * threshold);

		if (pageNumber >= completionPage) {
			const completionStatus = this.resolveCompletionStatus();
			if (getItemReadStatus(parentItem) !== completionStatus) {
				setItemReadStatus(parentItem, completionStatus);
			}
		}
	}

	private resolveCompletionStatus(): string {
		const saved = getPref(COMPLETION_STATUS_PREF) as string;
		if (saved && this.statusNames.includes(saved)) return saved;
		// Prefer an exact case-insensitive "Read" match, then the 4th status
		// (index 3 = "Read" in default list), then the last status.
		// Avoid partial matches like "To Read" or "Not Reading".
		const exactRead = this.statusNames.find((n) => /^read$/i.test(n));
		return (
			exactRead ??
			this.statusNames[3] ??
			this.statusNames[this.statusNames.length - 1]
		);
	}

	private debouncedSave(item: Zotero.Item) {
		const id = item.id;
		const existing = this.saveDebounceTimers.get(id);
		if (existing) clearTimeout(existing);
		this.saveDebounceTimers.set(
			id,
			setTimeout(() => {
				void item.saveTx();
				this.saveDebounceTimers.delete(id);
			}, 2000),
		);
	}
}
