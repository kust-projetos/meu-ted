import { createElement } from "react";
import { Activity, Armchair, ArrowLeftRight, Award, Baby, BadgeDollarSign, Banknote, BedDouble, Beer, Bell, Bike, Bone, BookHeart, BookOpen, Brain, Briefcase, Building2, Bus, CakeSlice, Calculator, CalendarClock, Camera, Car, CarFront, Cat, ChefHat, Check, ChevronDown, ChevronRight, CircleDollarSign, Clapperboard, ClipboardList, Coffee, Coins, CreditCard, Cross, Dices, Dog, DollarSign, DoorOpen, Droplets, Dumbbell, Fence, FileText, Film, Flag, Flame, Flower2, Fuel, Gamepad2, Gift, Glasses, GraduationCap, Hammer, HandCoins, Heart, HeartHandshake, HeartPulse, KeyRound, Lamp, Landmark, Languages, Laptop, LayoutTemplate, Library, Lightbulb, LineChart, Mail, MapPin, Martini, Milestone, Moon, Music, Palette, PartyPopper, PawPrint, PenLine, Percent, Phone, PiggyBank, Pill, Pizza, Plane, Plug, Popcorn, Presentation, Receipt, RotateCcw, Salad, Sandwich, Scale, Search, ShieldPlus, Shirt, ShoppingBag, ShoppingBasket, Smartphone, Smile, Sofa, Sparkles, Sprout, SquareParking, Star, Stethoscope, Store, Sun, Syringe, Tag, Target, Ticket, ToyBrick, Train, TrendingDown, TrendingUp, Tv, Umbrella, Users, UtensilsCrossed, Vault, Wallet, Watch, Wifi, Wrench, X, Zap } from "lucide-react";

const CATEGORY_ICONS: Record<string, typeof Tag> = { Activity, Armchair, ArrowLeftRight, Award, Baby, BadgeDollarSign, Banknote, BedDouble, Beer, Bell, Bike, Bone, BookHeart, BookOpen, Brain, Briefcase, Building2, Bus, CakeSlice, Calculator, CalendarClock, Camera, Car, CarFront, Cat, ChefHat, Check, ChevronDown, ChevronRight, CircleDollarSign, Clapperboard, ClipboardList, Coffee, Coins, CreditCard, Cross, Dices, Dog, DollarSign, DoorOpen, Droplets, Dumbbell, Fence, FileText, Film, Flag, Flame, Flower2, Fuel, Gamepad2, Gift, Glasses, GraduationCap, Hammer, HandCoins, Heart, HeartHandshake, HeartPulse, KeyRound, Lamp, Landmark, Languages, Laptop, LayoutTemplate, Library, Lightbulb, LineChart, Mail, MapPin, Martini, Milestone, Moon, Music, Palette, PartyPopper, PawPrint, PenLine, Percent, Phone, PiggyBank, Pill, Pizza, Plane, Plug, Popcorn, Presentation, Receipt, RotateCcw, Salad, Sandwich, Scale, Search, ShieldPlus, Shirt, ShoppingBag, ShoppingBasket, Smartphone, Smile, Sofa, Sparkles, Sprout, SquareParking, Star, Stethoscope, Store, Sun, Syringe, Tag, Target, Ticket, ToyBrick, Train, TrendingDown, TrendingUp, Tv, Umbrella, Users, UtensilsCrossed, Vault, Wallet, Watch, Wifi, Wrench, X, Zap };

export function getIconComponent(name: string) {
  return CATEGORY_ICONS[name] ?? Tag;
}

export function hasCategoryIcon(name: string) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_ICONS, name);
}

export function CategoryIcon({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  return createElement(getIconComponent(name), { size, className });
}
