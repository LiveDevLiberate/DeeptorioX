import tkinter as tk
from tkinter import scrolledtext

import pyperclip


def show_error_popup(title: str, message: str) -> None:
    """
    Opens a simple Tkinter popup window displaying an error message with a copy-to-clipboard button.
    """

    def copy_to_clipboard() -> None:
        """
        Copies the error message to the clipboard.
        """
        pyperclip.copy(message)

    root = tk.Tk()
    root.title(title)
    root.geometry("600x400")
    root.resizable(False, False)

    label = tk.Label(root, text="An error occurred:", font=("Segoe UI", 12, "bold"))
    label.pack(pady=(10, 5))

    text_area = scrolledtext.ScrolledText(root, wrap=tk.WORD, height=15, font=("Consolas", 10))
    text_area.insert(tk.END, message)
    text_area.configure(state="disabled")
    text_area.pack(padx=10, pady=5, fill="both", expand=True)

    copy_btn = tk.Button(root, text="Copy to Clipboard", command=copy_to_clipboard)
    copy_btn.pack(pady=(0, 10))

    root.mainloop()
