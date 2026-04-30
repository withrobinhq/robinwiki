"use client";

import { useState } from "react";
import { T } from "@/lib/typography";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/hooks/useSession";
import { useLogout } from "@/hooks/useLogout";

import AddWikiModal from "@/components/layout/AddWikiModal";
import AddEntryModal from "@/components/layout/AddEntryModal";
import AddPersonModal from "@/components/layout/AddPersonModal";
import WikiHeaderSearch from "@/components/layout/WikiHeaderSearch";

interface HeaderProps {
  onMenuToggle: () => void;
}

export default function Header({ onMenuToggle }: HeaderProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addWikiOpen, setAddWikiOpen] = useState(false);
  const [addEntryOpen, setAddEntryOpen] = useState(false);
  const [addPersonOpen, setAddPersonOpen] = useState(false);
  const { session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const logout = useLogout();
  const isWikiHome = pathname === "/wiki";

  const addWikiFg = "var(--wiki-link)";

  return (
    <header className="flex h-full w-full min-h-0 items-center gap-3">
      <div className="flex shrink-0 items-center">
        <button
          onClick={onMenuToggle}
          className="flex cursor-pointer items-center justify-center"
          style={{
            padding: "4px 12px",
            height: 32,
            borderRadius: 2,
            background: "none",
            border: "none",
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M1 4V6H19V4H1ZM1 11H19V9H1V11ZM1 16H19V14H1V16Z"
              fill="var(--wiki-header-icon)"
            />
          </svg>
        </button>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-1">
        {isWikiHome ? (
          <div className="h-[38px] min-w-0 flex-1 max-w-[591px]" aria-hidden />
        ) : (
          <WikiHeaderSearch />
        )}
      </div>

      <div
        className="flex shrink-0 items-center"
        style={{ gap: 16, position: "relative" }}
      >
        <button
          type="button"
          onClick={() => setAddEntryOpen(true)}
          className="flex cursor-pointer items-center justify-center"
          style={{
            gap: 4,
            padding: "8px 12px",
            height: 35,
            boxSizing: "border-box",
            background: "transparent",
            border: "none",
            borderRadius: 2,
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden
          >
            <path
              d="M12 5v14M5 12h14"
              stroke={addWikiFg}
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <span
            style={{
              ...T.bodySmall,
              fontWeight: 600,
              lineHeight: "normal",
              letterSpacing: "-0.0336px",
              color: addWikiFg,
              whiteSpace: "nowrap",
            }}
          >
            Add Entry
          </span>
        </button>

        <div style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setAddMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            className="wiki-add-wiki-btn flex cursor-pointer items-center justify-center"
            style={{
              gap: 4,
              padding: "8px 12px",
              height: 35,
              boxSizing: "border-box",
              background: "transparent",
              border: "none",
              borderRadius: 2,
            }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden
            >
              <path
                d="M12 5v14M5 12h14"
                stroke={addWikiFg}
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <span
              style={{
                ...T.bodySmall,
                fontWeight: 600,
                lineHeight: "normal",
                letterSpacing: "-0.0336px",
                color: addWikiFg,
                whiteSpace: "nowrap",
              }}
            >
              Add Wiki
            </span>
          </button>

          {addMenuOpen && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 40 }}
                onClick={() => setAddMenuOpen(false)}
              />
              <div
                role="menu"
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  zIndex: 50,
                  minWidth: 160,
                  backgroundColor: "var(--bg)",
                  border: "1px solid var(--card-border)",
                  borderRadius: 6,
                  padding: "4px 0",
                  boxShadow: "var(--shadow-dropdown)",
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setAddWikiOpen(true);
                  }}
                  className="flex w-full cursor-pointer items-center"
                  style={{
                    gap: 10,
                    padding: "8px 14px",
                    background: "none",
                    border: "none",
                    ...T.caption,
                    color: "var(--heading-color)",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.backgroundColor = "var(--card-border)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.backgroundColor = "transparent")
                  }
                >
                  Wiki
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setAddPersonOpen(true);
                  }}
                  className="flex w-full cursor-pointer items-center"
                  style={{
                    gap: 10,
                    padding: "8px 14px",
                    background: "none",
                    border: "none",
                    ...T.caption,
                    color: "var(--heading-color)",
                    textAlign: "left",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.backgroundColor = "var(--card-border)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.backgroundColor = "transparent")
                  }
                >
                  Person
                </button>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center" style={{ gap: 8, position: "relative" }}>
          <div className="flex items-start">
          <span
            style={{
              ...T.bodySmall,
              letterSpacing: "-0.042px",
              color: "var(--wiki-header-user)",
              padding: "0 6px",
              whiteSpace: "nowrap",
            }}
          >
            {session?.user?.name ?? session?.user?.email ?? ""}
          </span>
          </div>

          <button
          onClick={() => setDropdownOpen((v) => !v)}
          className="flex items-center justify-center"
          style={{
            background: "none",
            border: "none",
            gap: 6,
            paddingLeft: 6,
            paddingRight: 8,
            paddingTop: 6,
            paddingBottom: 6,
            borderRadius: 2,
            cursor: "pointer",
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M10 11C15.917 11 18 14 18 16V19H2V16C2 14 4.083 11 10 11ZM10 1C12.485 1 14.5 3.015 14.5 5.5C14.5 7.985 12.485 10 10 10C7.515 10 5.5 7.985 5.5 5.5C5.5 3.015 7.515 1 10 1Z"
              fill="var(--wiki-header-icon)"
            />
          </svg>
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{
              transform: dropdownOpen ? "rotate(180deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M12.8 6.21088L11.8736 5.2L8 8.9056L4.21088 5.2L3.2 6.21088L8 11.0109L12.8 6.21088"
              fill="var(--wiki-header-icon)"
            />
          </svg>
          </button>

          {dropdownOpen && (
          <>
            <div
              style={{ position: "fixed", inset: 0, zIndex: 40 }}
              onClick={() => setDropdownOpen(false)}
            />
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                zIndex: 50,
                minWidth: 160,
                backgroundColor: "var(--bg)",
                border: "1px solid var(--card-border)",
                borderRadius: 6,
                padding: "4px 0",
                boxShadow: "var(--shadow-dropdown)",
              }}
            >
              <button
                onClick={() => {
                  setDropdownOpen(false);
                  router.push("/profile");
                }}
                className="flex w-full cursor-pointer items-center"
                style={{
                  gap: 10,
                  padding: "8px 14px",
                  background: "none",
                  border: "none",
                  ...T.caption,
                  color: "var(--heading-color)",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.backgroundColor =
                    "var(--card-border)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.backgroundColor = "transparent")
                }
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" stroke="var(--wiki-header-icon)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <circle cx="12" cy="12" r="3" stroke="var(--wiki-header-icon)" strokeWidth="1.5"/>
                </svg>
                Settings
              </button>
              <button
                onClick={async () => {
                  setDropdownOpen(false);
                  await logout();
                }}
                className="flex w-full cursor-pointer items-center"
                style={{
                  gap: 10,
                  padding: "8px 14px",
                  background: "none",
                  border: "none",
                  ...T.caption,
                  color: "var(--heading-color)",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.backgroundColor =
                    "var(--card-border)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.backgroundColor = "transparent")
                }
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="var(--wiki-header-icon)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Log out
              </button>
            </div>
          </>
          )}
        </div>
      </div>

      <AddWikiModal open={addWikiOpen} onClose={() => setAddWikiOpen(false)} />
      <AddEntryModal open={addEntryOpen} onClose={() => setAddEntryOpen(false)} />
      <AddPersonModal open={addPersonOpen} onClose={() => setAddPersonOpen(false)} />
    </header>
  );
}
