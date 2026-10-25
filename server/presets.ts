import type { Quest } from "../shared/types.ts";

type Preset = Omit<Quest, "id">;

/** Scripted quests for the stage demo. Stage the room with exactly these objects. */
export const PRESETS: Record<string, Preset> = {
  desk: {
    title: "Tidy the desk",
    type: "boss",
    intro: "Your desk looks cluttered. We'll put the bottle away and stow the book.",
    goalCheck: "Is the desk clear, with no water bottle or book left on it?",
    steps: [
      {
        id: "s1",
        action: "grab",
        target: "water bottle",
        destination: "",
        instruction: "Find the water bottle on the desk and pick it up.",
        success: "A hand is holding the water bottle.",
        check: "Is a hand holding the water bottle?",
      },
      {
        id: "s2",
        action: "drop",
        target: "water bottle",
        destination: "trash can",
        instruction: "Carry it to the trash can and drop it in.",
        success: "The water bottle is inside the trash can.",
        check: "Is the water bottle inside the trash can?",
      },
      {
        id: "s3",
        action: "grab",
        target: "book",
        destination: "",
        instruction: "Pick up the book on the desk.",
        success: "A hand is holding the book.",
        check: "Is a hand holding the book?",
      },
      {
        id: "s4",
        action: "place",
        target: "book",
        destination: "backpack",
        instruction: "Put the book in your backpack.",
        success: "The book is inside the backpack.",
        check: "Is the book inside the backpack?",
      },
    ],
  },
  trash: {
    title: "Trash the bottle",
    type: "side",
    intro: "There's a bottle on the desk. We'll move it to the trash.",
    goalCheck: "Is the water bottle in the trash can and off the desk?",
    steps: [
      {
        id: "s1",
        action: "grab",
        target: "water bottle",
        destination: "",
        instruction: "Find the bottle on the desk and pick it up.",
        success: "A hand is holding the water bottle.",
        check: "Is a hand holding the water bottle?",
      },
      {
        id: "s2",
        action: "drop",
        target: "water bottle",
        destination: "trash can",
        instruction: "Carry it to the trash can and drop it in.",
        success: "The water bottle is inside the trash can.",
        check: "Is the water bottle inside the trash can?",
      },
    ],
  },
  seat: {
    title: "Find a seat",
    type: "side",
    intro: "Let's find a chair and sit down.",
    goalCheck: "Is the player seated on the chair?",
    steps: [
      {
        id: "s1",
        action: "find",
        target: "chair",
        destination: "",
        instruction: "Pan slowly until you see a chair straight ahead.",
        success: "The chair is clearly visible and centered.",
        check: "Is a chair clearly visible straight ahead?",
      },
      {
        id: "s2",
        action: "sit",
        target: "chair",
        destination: "",
        instruction: "Walk to the chair, feel for the seat, and sit down.",
        success: "The view is at seated height on the chair.",
        check: "Is the view at seated height, on or directly in front of the chair?",
      },
    ],
  },
};
